local Tasks = import 'LrTasks'
local Files = import 'LrFileUtils'
local Paths = import 'LrPathUtils'
local App = import 'LrApplication'
local Export = import 'LrExportSession'
local MD5 = import 'LrMD5'
local Dialogs = import 'LrDialogs'

if _G.BELLOStationRunning then return end
local config = Paths.child(_PLUGIN.path, 'root.txt')
if not Files.exists(config) then
    Dialogs.message('BELLO Photo Station', 'root.txt がありません。配布パッケージのセットアップを実行してください。', 'warning')
    return
end
local root = Files.readFile(config):gsub('^\239\187\191', ''):gsub('%s+$', '')
local bridge = Paths.child(root, 'lightroom')
local requests = Paths.child(bridge, 'requests')
Files.createAllDirectories(requests)
_G.BELLOStationRunning = true

-- Deterministic JSON also fingerprints the actual loaded Lightroom preset.
local function encode(value)
    local kind = type(value)
    if kind == 'string' then
        return '"' .. value:gsub('[%z\1-\31\\"]', function(c)
            if c == '\\' then return '\\\\' end
            if c == '"' then return '\\"' end
            return string.format('\\u%04x', string.byte(c))
        end) .. '"'
    elseif kind == 'number' or kind == 'boolean' then return tostring(value)
    elseif kind == 'nil' then return 'null'
    elseif kind == 'table' then
        local keys, parts = {}, {}
        for k in pairs(value) do keys[#keys + 1] = k end
        table.sort(keys, function(a,b) return tostring(a) < tostring(b) end)
        for _, k in ipairs(keys) do parts[#parts + 1] = encode(tostring(k)) .. ':' .. encode(value[k]) end
        return '{' .. table.concat(parts, ',') .. '}'
    end
    error('Unsupported preset value: ' .. kind)
end
local function writeResult(file, value)
    local f = assert(io.open(file .. '.partial', 'wb'))
    f:write(encode(value)); f:close()
    if Files.exists(file) then Files.delete(file) end
    assert(Files.move(file .. '.partial', file))
end
local function normalize(p) return p:gsub('\\', '/'):lower():gsub('/+$', '') end
-- Packaging on Windows can change line endings without changing the recipe.
local function presetBytes(value)
    local normalized = value:gsub('^\239\187\191', ''):gsub('\r\n', '\n'):gsub('\r', '\n')
    return normalized
end
local function under(base, file)
    local b, p = normalize(base), normalize(file)
    return p:sub(1, #b + 1) == b .. '/' and not p:find('/../', 1, true)
end
local function unhex(s)
    assert(#s % 2 == 0 and not s:find('[^0-9a-f]'), 'Invalid request encoding')
    return (s:gsub('..', function(c) return string.char(tonumber(c, 16)) end))
end
local function renderJob(file, id)
    local job = Paths.child(Paths.child(bridge, 'jobs'), id)
    local resultFile = Paths.child(job, 'result.json')
    local ok, result = Tasks.pcall(function()
        local fields = {}
        for line in (Files.readFile(file) .. '\n'):gmatch('(.-)\n') do fields[#fields + 1] = unhex(line) end
        assert(fields[1] == 'BELLO2' and fields[2] == id and (#fields == 9 or #fields == 10), 'Invalid request')
        local input, presetId, presetFile = fields[3], fields[4], fields[5]
        assert(under(job, input) and Files.exists(input), 'Invalid input path')
        local edge, quality, deadline = tonumber(fields[6]), tonumber(fields[7]), tonumber(fields[8])
        assert(edge and edge >= 64 and edge <= 20000 and quality and quality >= 1 and quality <= 100, 'Invalid export settings')
        local function checkCancelled()
            assert(os.time() * 1000 <= deadline and not Files.exists(Paths.child(job, 'cancelled')), 'Request expired')
        end
        checkCancelled()
        local preset, signature = nil, 'original'
        if presetId ~= '' then
            assert(under(Paths.child(root, 'presets'), presetFile), 'Invalid preset path')
            local raw = presetId:gsub('-', ''):upper()
            local registered = Files.readFile(presetFile)
            local registeredUuid = registered:match('crs:UUID="([^"]+)"')
            assert(registeredUuid and registeredUuid:gsub('-', ''):upper() == raw, '登録済みXMPのIDが一致しません。')
            -- Lightroom assigns a different SDK UUID when an XMP is imported.
            -- Match its exact contents instead, so an old copy cannot be used.
            local wantedHash = MD5.digest(presetBytes(registered))
            for _, folder in ipairs(App.developPresetFolders()) do
                for _, candidate in ipairs(folder:getDevelopPresets()) do
                    local file = candidate:getFile()
                    if file and Files.exists(file) then
                        local bytes = Files.readFile(file)
                        if bytes and MD5.digest(presetBytes(bytes)) == wantedHash then
                            assert(not preset, '同じ内容のLightroomプリセットが重複しています。')
                            preset = candidate
                        end
                    end
                end
            end
            assert(preset, 'Lightroomに同じ内容のプリセットがありません。XMPを読み込み直してください。')
            -- getSetting() can contain per-photo AI-mask values and changes
            -- between renders of the same XMP. The exact imported file is
            -- the stable version used for preview/final approval.
            signature = wantedHash
            if fields[9] ~= '' then assert(signature == fields[9], 'プリセットが変更されています。再比較してください。') end
        end
        local catalog, photo = App.activeCatalog(), nil
        -- Each job imports a unique disposable copy: no edits to the user's originals/catalog photos.
        catalog:withWriteAccessDo('BELLO: import working copy', function() photo = catalog:addPhoto(input) end)
        assert(photo, 'Cannot import working copy')
        -- A previously selected temporary file may no longer exist. Show this
        -- job's new copy instead of leaving Lightroom on that missing photo.
        local folder = catalog:getFolderByPath(job)
        if folder then catalog:setActiveSources({ folder }) end
        catalog:setSelectedPhotos(photo, {})
        if preset then
            catalog:withWriteAccessDo('BELLO: apply preset', function()
                photo:applyDevelopPreset(preset, nil, 100, true)
            end)
        end
        checkCancelled()
        local exportDir = Paths.child(job, 'export')
        local keepFrame = fields[10] == 'KEEP_FRAME'
        if keepFrame then
            catalog:withWriteAccessDo('BELLO: preserve touch framing', function()
                photo:applyDevelopSettings({
                    CropTop = 0, CropLeft = 0, CropBottom = 1, CropRight = 1, CropAngle = 0,
                    PerspectiveUpright = 0, PerspectiveVertical = 0, PerspectiveHorizontal = 0,
                    PerspectiveRotate = 0, PerspectiveScale = 100, PerspectiveAspect = 0,
                    PerspectiveX = 0, PerspectiveY = 0, LensProfileEnable = 0
                })
            end)
        end
        Files.createAllDirectories(exportDir)
        local session = Export { photosToExport = { photo }, exportSettings = {
            LR_export_destinationType = 'specificFolder', LR_export_destinationPathPrefix = exportDir,
            LR_export_useSubfolder = false, LR_collisionHandling = 'overwrite',
            LR_format = 'JPEG', LR_jpeg_quality = quality / 100, LR_export_colorSpace = 'sRGB',
            LR_size_doConstrain = true, LR_size_resizeType = 'longEdge', LR_size_maxHeight = edge,
            LR_size_maxWidth = edge, LR_size_units = 'pixels', LR_size_doNotEnlarge = true,
            LR_outputSharpeningOn = false, LR_minimizeEmbeddedMetadata = true,
            LR_removeLocationMetadata = true, LR_reimportExportedPhoto = false,
            LR_renamingTokensOn = false,
        } }
        local output
        for _, rendition in session:renditions() do
            local success, rendered = rendition:waitForRender()
            assert(success, tostring(rendered)); output = rendered
        end
        assert(output and under(job, output), 'No valid rendered output')
        checkCancelled()
        assert(Files.move(output, Paths.child(job, 'render.jpg')))
        return { ok = true, signature = signature, preserveFraming = keepFrame }
    end)
    if not ok then result = { ok = false, error = tostring(result) } end
    writeResult(resultFile, result)
end
Tasks.startAsyncTask(function()
    while _G.BELLOStationRunning do
        local ok, err = Tasks.pcall(function() writeResult(Paths.child(bridge, 'heartbeat.json'), {
            protocol = 2, bridgeVersion = 10, unixMs = os.time() * 1000, pluginPath = _PLUGIN.path
        }) end)
        if not ok then
            _G.BELLOStationRunning = false
            Dialogs.message('BELLO Photo Station', '連携先に接続情報を書き込めません。\n' .. tostring(err), 'critical')
        end
        Tasks.sleep(2)
    end
end)
Tasks.startAsyncTask(function()
    while _G.BELLOStationRunning do
        local ok, err = Tasks.pcall(function()
            for file in Files.files(requests) do
                local id = Paths.leafName(file):match('^([a-f0-9%-]+)%.ready$')
                if id and #id == 36 then
                    local claimed = file .. '.working'
                    if Files.move(file, claimed) then
                        renderJob(claimed, id)
                        Files.delete(claimed)
                    end
                end
            end
        end)
        if not ok then
            _G.BELLOStationRunning = false
            Dialogs.message('BELLO Photo Station', tostring(err), 'critical')
        end
        Tasks.sleep(0.5)
    end
end)

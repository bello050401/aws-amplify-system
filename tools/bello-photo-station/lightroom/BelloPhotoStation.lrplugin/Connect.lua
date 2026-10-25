local Paths = import 'LrPathUtils'
return {
    URLHandler = function(url)
        -- Fixed local reconnect command only; never execute URL-supplied code or paths.
        if url == 'lightroom://jp.bello.photo-station/connect' then
            dofile(Paths.child(_PLUGIN.path, 'Start.lua'))
        end
    end,
}

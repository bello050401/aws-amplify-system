return {
    LrSdkVersion = 14.0,
    LrSdkMinimumVersion = 13.3,
    LrToolkitIdentifier = 'jp.bello.photo-station',
    LrPluginName = 'BELLO Photo Station',
    LrInitPlugin = 'Start.lua',
    LrForceInitPlugin = true,
    LrEnablePlugin = 'Start.lua',
    LrDisablePlugin = 'Stop.lua',
    LrShutdownPlugin = 'Stop.lua',
    URLHandler = 'Connect.lua',
    LrLibraryMenuItems = {
        { title = 'BELLO連携を開始', file = 'Start.lua' },
        { title = 'BELLO連携を停止', file = 'Stop.lua' },
    },
    VERSION = { major = 1, minor = 0, revision = 10 },
}

{
  "targets": [
    {
      "target_name": "addon",
      "sources": ["addon.cc", "game_server.cc"],
      "include_dirs": [
        "<(module_root_dir)/../node_modules/node-addon-api"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "cflags_cc": ["-std=c++17"],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"]
    }
  ]
}

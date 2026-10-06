{
  "target_defaults": {
    "include_dirs": ["<!(node -p \"require('path').dirname(require.resolve('node-addon-api/package.json', {paths: [require.resolve('win-capture')]}))\")"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE", "NOMINMAX", "WIN32_LEAN_AND_MEAN"],
    "libraries": ["-ld3d11.lib", "-ld3dcompiler.lib", "-ldxgi.lib", "-ldxguid.lib", "-lwindowsapp.lib", "-lole32.lib", "-loleaut32.lib", "-luser32.lib", "-lwinmm.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"]}
    }
  },
  "targets": [
    {"target_name": "wgc_acquisition_probe", "sources": ["probe.cc"]},
    {"target_name": "wgc_production_reference", "sources": ["production-reference.cc"]}
  ]
}

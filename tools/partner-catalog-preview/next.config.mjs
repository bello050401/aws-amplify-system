import applicationConfig from '../../next.config.mjs';

export default {
  poweredByHeader:false,
  devIndicators:false,

  experimental:{cpus:2},
  async headers(){
    return [{source:'/:path*',headers:[
      {key:'Cache-Control',value:'no-store'},
      {key:'Content-Security-Policy',value:"default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"},
    ]},...await applicationConfig.headers()];
  },
};

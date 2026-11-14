export default {
  poweredByHeader:false,
  devIndicators:false,

  experimental:{cpus:2},
  async headers(){
    return [{source:'/:path*',headers:[
      {key:'Cache-Control',value:'no-store'},
      {key:'Referrer-Policy',value:'no-referrer'},
      {key:'Content-Security-Policy',value:"default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"},
    ]}];
  },
};

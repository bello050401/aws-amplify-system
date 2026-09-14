for(const k of ['https_proxy','HTTPS_PROXY','http_proxy','HTTP_PROXY']) delete process.env[k];
process.env.INVENTORY_E2E_FIXTURES='1';
process.env.INVENTORY_E2E_AUTH_TOKEN='e2e-local-test-token-not-a-real-secret-32c';
process.argv=[process.argv[0],process.argv[1],'dev','--port','3120'];require('next/dist/bin/next');

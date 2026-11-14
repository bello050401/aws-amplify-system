import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir:'./test',workers:1,timeout:30_000,
  use:{baseURL:process.env.BELLO_PREVIEW_TEST_URL ?? 'http://127.0.0.1:4189',browserName:'chromium',headless:true},
  outputDir:process.env.BELLO_PREVIEW_TEST_OUTPUT ?? 'test-results',
});

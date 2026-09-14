import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',testMatch:'mercari-api-removal.spec.ts',timeout:90000,workers:1,use:{baseURL:'http://127.0.0.1:3120'},webServer:{command:'node scripts/qa-removal-dev.cjs',url:'http://127.0.0.1:3120/inventory/login',timeout:120000,reuseExistingServer:false}});

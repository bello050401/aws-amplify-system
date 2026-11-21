'use client';
import { useEffect } from 'react';
import { monitorBrowserErrors } from '@/lib/systemErrors/client';
export function SystemErrorMonitor() {
  useEffect(() => monitorBrowserErrors(), []);
  return null;
}

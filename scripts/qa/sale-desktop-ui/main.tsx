import React from 'react';
import {createRoot} from 'react-dom/client';
import {DesktopSaleJobs} from '../../../components/sales/DesktopSaleJobs';
createRoot(document.getElementById('root')!).render(<><div className="bg-amber-50 p-3 text-center text-sm">検証環境 — 架空商品だけを使用し、実際の在庫やECには接続しません</div><DesktopSaleJobs/></>);

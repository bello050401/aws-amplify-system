import React from 'react';
export default function Icon(){return <span aria-hidden="true">◇</span>;}
export function Image({accessibilityLabel,style}:any){return <span aria-label={accessibilityLabel} style={{...style,display:'inline-block',background:'#D5DFD7'}}/>;}
export function Link({href,children,...props}:any){return <a href={href} {...props}>{children}</a>;}
const blocked=async()=>({ok:false,error:'動作確認用：外部接続・実在庫更新は行いません。'});
export const fetchRestageAction=blocked,prepareRestageRunAction=blocked,registerRestageLotAction=blocked,fetchTrefacAction=blocked,registerTrefacAction=blocked,startYahooProcurementAction=blocked,readYahooProcurementAction=blocked,previewYahooProcurementAction=blocked,prepareYahooProcurementPhotoAction=blocked,registerYahooProcurementAction=blocked,excludeYahooProcurementAction=blocked,listSupplierExtractionAction=blocked,requestSupplierExtractionAction=blocked,cancelSupplierExtractionAction=blocked;

import React from "react";
import type {DateFieldProps} from "./DateField";
export function DateField({label,value,disabled,onChange}:DateFieldProps){
  return <input type="date" aria-label={label} value={value.replaceAll("/","-")} disabled={disabled} onChange={event=>onChange(event.target.value)} style={{fontFamily:"inherit",fontSize:17,color:"#303633",background:"white",border:"1px solid #AAAFAA",borderRadius:10,padding:14,minHeight:54,width:"100%",boxSizing:"border-box"}}/>;
}

import type {WorkInteractionInput} from '@socrates/core';
export interface PendingInteraction {key:string;input:WorkInteractionInput}
/** A replacement quote after a lost response cannot turn one instruction into two paid calls. */
export function reserveInteraction(previous:PendingInteraction|null,input:WorkInteractionInput):PendingInteraction {
 const {clientRequestId:_request,quoteId:_quote,...semantic}=input;
 const key=JSON.stringify(semantic);
 return previous?.key===key?previous:{key,input:{...structuredClone(input),clientRequestId:crypto.randomUUID()}};
}

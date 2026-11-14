/* One serial scheduler for library and reader requests. Persisted progress lives in jobs. */
(function(root){
  'use strict';
  class Queue {
    constructor({prepare,run,change=()=>{},pause=()=>{}}){Object.assign(this,{prepare,run,change,pause});this.entries=[];this.active=null;this.closed=false;this.scheduled=false;}
    enqueue(input){
      if(this.closed)throw new Error('翻译队列已关闭');
      let entry=this.entries.find(e=>e.key===input.key&&['waiting','parsing','translating'].includes(e.state));
      if(entry)return entry;
      entry={...input,settings:JSON.parse(JSON.stringify(input.settings)),state:'waiting',error:'',cancelled:false,discarded:false};
      this.entries=this.entries.filter(e=>e.key!==entry.key);this.entries.push(entry);this.change(entry);this.kick();return entry;
    }
    kick(){if(this.closed||this.active||this.scheduled)return;this.scheduled=true;Promise.resolve().then(()=>{this.scheduled=false;return this.drain();});}
    async drain(){
      if(this.closed||this.active)return;
      const e=this.entries.find(e=>e.state==='waiting');if(!e)return;
      this.active=e;
      try{
        e.state='parsing';this.change(e);
        const job=await this.prepare(e);e.jobID=job.id;
        if(e.cancelled||this.closed)return;
        e.state='translating';this.change(e);await this.run(job,e);
        e.state=e.cancelled||job.status==='paused'?'paused':job.status==='complete'?'complete':'failed';e.error=job.error||'';
      }catch(error){e.state=e.cancelled?'paused':'failed';e.error=e.cancelled?'':String(error.message||error);}
      finally{if(e.cancelled)e.state=e.discarded?'cancelled':'paused';this.active=null;this.change(e);this.kick();}
    }
    cancel(predicate=()=>true,{discard=false}={}){
      for(const e of this.entries)if(predicate(e)&&(['waiting','parsing','translating'].includes(e.state)||discard&&e.state==='paused')){
        e.cancelled=true;e.discarded=discard;e.state=discard?'cancelled':'paused';this.pause(e);this.change(e);
      }
    }
    stop(){this.closed=true;this.cancel();}
  }
  if(typeof module==='object')module.exports={Queue};else root.ParallelQueue={Queue};
})(typeof module!=='undefined'&&module.exports?globalThis:this);

/* Wire formats only. Credentials never enter request bodies or saved jobs. */
(function(root){
  "use strict";
  const paths={"openai-chat":"/chat/completions","openai-responses":"/responses","anthropic":"/messages"};
  function type(settings={}){const value=settings.apiType||"openai-chat";if(!paths[value])throw new Error("不支持的 API 协议");return value;}
  function endpoint(value,protocol="openai-chat"){
    type({apiType:protocol});let u;
    try{u=new URL(String(value).trim());}catch(_){throw new Error("请输入有效的 API 地址");}
    if(u.username||u.password||u.hash)throw new Error("API 地址不能包含账号、密码或 # 片段");
    if(u.protocol!=="https:"&&!(u.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(u.hostname)))throw new Error("远程 API 请使用 HTTPS；HTTP 仅支持本机服务");
    let p=u.pathname.replace(/\/+$/,"")||"/v1";
    const suffix=Object.values(paths).find(path=>p.endsWith(path));
    if(suffix&&suffix!==paths[protocol])throw new Error("API 地址与所选协议不匹配，请检查地址或切换协议");
    if(!suffix)p+=paths[protocol];u.pathname=p;return u.href;
  }
  function headers(settings,key){
    const h={"Content-Type":"application/json"},protocol=type(settings);
    if(protocol==="anthropic")h["anthropic-version"]="2023-06-01";
    const auth=settings.authMode||"auto";
    if(!["auto","bearer","x-api-key"].includes(auth))throw new Error("不支持的鉴权方式");
    if(key){if(auth==="x-api-key"||auth==="auto"&&protocol==="anthropic")h["x-api-key"]=key;else h.Authorization="Bearer "+key;}
    return h;
  }
  function modelsEndpoint(settings={},after){
    const protocol=type(settings),u=new URL(endpoint(settings.endpoint,protocol));
    u.pathname=u.pathname.slice(0,-paths[protocol].length)+"/models";
    if(after)u.searchParams.set("after_id",after);
    return u.href;
  }
  const effortLevels=["none","minimal","low","medium","high","xhigh","max","ultra"];
  function modelPage(response){
    const data=Array.isArray(response)?response:response?.data||response?.models;
    if(response?.error||!Array.isArray(data))throw new Error("接口未返回模型列表，请检查地址是否支持 models 接口。");
    const models=new Map();
    for(const row of data){
      const id=typeof row==="string"?row:row?.id;
      if(typeof id!=="string"||!id.trim()||id.length>200||/[\u0000-\u001f\u007f]/.test(id))continue;
      let levels=null;
      const reported=row.supported_reasoning_levels??row.reasoning_levels;
      const capability=row.capabilities?.effort;
      if(Array.isArray(reported))levels=reported.map(v=>typeof v==="string"?v:v?.effort).filter(v=>typeof v==="string").map(v=>v.toLowerCase()==="mid"?"medium":v.toLowerCase());
      else if(capability&&typeof capability==="object"){
        if(capability.supported===false)levels=[];
        else if(effortLevels.some(k=>k in capability))levels=effortLevels.filter(k=>capability[k]===true||capability[k]?.supported===true);
      }
      if(levels===null&&(row.reasoning===false||row.capabilities?.thinking?.supported===false))levels=[];
      const name=row.display_name||row.name;
      const model={id:id.trim(),name:typeof name==="string"?name.slice(0,200):id.trim(),efforts:levels===null?null:effortLevels.filter(k=>levels.includes(k))};
      if(!models.has(model.id))models.set(model.id,model);
    }
    const more=response?.has_more===true;
    const after=typeof response?.last_id==="string"?response.last_id:null;
    if(more&&(!after||after.length>500))throw new Error("模型列表分页信息不完整，请检查服务配置。");
    return {models:[...models.values()],more,after};
  }
  function effortOptions(settings,model){
    const advertised=model?.efforts;
    // Extra gateway levels are only offered when explicitly advertised.
    const choices=advertised??["low","medium","high","xhigh","max"];
    return ["auto",...choices.filter(level=>{
      try{reasoning({...settings,reasoningEffort:level,maxOutputTokens:65536});return true;}catch(_){return false;}
    })];
  }
  function effort(value){
    value=String(value||"auto").toLowerCase().trim();if(value==="mid")value="medium";
    if(!["auto",...effortLevels].includes(value))throw new Error("不支持的推理强度");
    return value;
  }
  function reasoning(settings){
    const level=effort(settings.reasoningEffort),protocol=type(settings);
    if(level==="auto")return {};
    if(protocol==="openai-chat")return {reasoning_effort:level};
    if(protocol==="openai-responses")return {reasoning:{effort:level}};
    if(["none","minimal","ultra"].includes(level))throw new Error("此推理档位仅支持 OpenAI / Responses 兼容接口，请选择默认或其他档位。");
    const model=String(settings.model||"").toLowerCase().split("/").at(-1).replace(/\./g,"-");
    const manual=/^claude-(?:(?:opus|sonnet)-4(?:-(?:1|5))?|haiku-4-5|3-7-sonnet)(?:-\d{8}|-latest)?$/.test(model);
    if(manual){
      const budget={low:1024,medium:2048,high:4096,xhigh:8192,max:16384}[level];
      if((settings.maxOutputTokens||8192)<budget+1024)throw new Error("此模型的 "+level+" 档使用 "+budget+" 个思考 token；输出 token 上限请至少设为 "+(budget+1024));
      return {thinking:{type:"enabled",budget_tokens:budget},...(/^claude-opus-4-5/.test(model)?{output_config:{effort:["xhigh","max"].includes(level)?"high":level}}:{})};
    }
    if(/^claude-3(?:-|$)/.test(model))throw new Error("此旧版 Claude 模型不支持推理强度，请选择默认或使用支持思考的模型");
    if(/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(model)&&level==="xhigh")throw new Error("Claude 4.6 不支持 Xhigh，请选择 High 或 Max");
    return {thinking:{type:"adaptive"},output_config:{effort:level}};
  }
  function reasoningHint(settings){
    const level=effort(settings.reasoningEffort);
    if(level==="auto")return "默认不发送推理参数，保留服务端行为。强度越高通常越慢、用量越多，不保证翻译更准确。";
    const wire=reasoning(settings);
    if(wire.thinking?.budget_tokens)return "此旧版 Claude 使用手动思考预算："+wire.thinking.budget_tokens+" token（插件档位映射）；输出上限包含思考和译文。";
    return "按所选协议发送 "+level+"。具体档位由模型/网关支持；不支持时请选择默认。强度不等于翻译准确率。";
  }
  function encode(settings,body){
    const protocol=type(settings),thinking=reasoning(settings);if(protocol==="openai-chat")return Object.keys(thinking).length?{...body,...thinking}:body;
    const system=body.messages.filter(m=>m.role==="system").map(m=>m.content).join("\n"),messages=body.messages.filter(m=>m.role!=="system");
    if(protocol==="anthropic")return {model:body.model,stream:false,max_tokens:settings.maxOutputTokens||8192,...(system?{system}:{}),messages,...thinking};
    return {model:body.model,stream:false,store:false,max_output_tokens:settings.maxOutputTokens||8192,...(system?{instructions:system}:{}),input:messages,...thinking};
  }
  function text(response,settings={}){
    const protocol=type(settings);let value;
    if(response?.error)throw new Error("接口返回错误，请检查模型、权限和服务状态");
    if(protocol==="openai-chat"){
      const choice=response?.choices?.[0];
      if(choice?.finish_reason==="length")throw new Error("模型输出被截断；请减小片段上限或提高服务端输出限制");
      if(choice?.message?.refusal||["content_filter","tool_calls","function_call"].includes(choice?.finish_reason))throw new Error("模型未返回完整翻译");
      value=choice?.message?.content;
    }else if(protocol==="anthropic"){
      if(!["end_turn","stop_sequence"].includes(response?.stop_reason))throw new Error(response?.stop_reason==="max_tokens"?"模型输出被截断；请提高输出 token 上限或减小片段上限":"Anthropic 未返回完整文本结果");
      value=response.content?.filter(b=>b.type==="text").map(b=>b.text).join("");
    }else{
      if(response?.status!=="completed")throw new Error(response?.status==="incomplete"?"模型输出不完整；请提高输出 token 上限或减小片段上限":"Responses 接口未完成文本生成");
      const content=(response.output||[]).filter(item=>item.type==="message"&&item.role==="assistant").flatMap(item=>item.content||[]);
      if(content.some(b=>b.type==="refusal"))throw new Error("模型拒绝了此批翻译");
      value=content.filter(b=>b.type==="output_text").map(b=>b.text).join("");
    }
    if(typeof value!=="string"||!value.trim())throw new Error("接口未返回所选协议的文本结果");
    return value;
  }
  function usage(response){return {input:Number(response?.usage?.prompt_tokens??response?.usage?.input_tokens)||0,output:Number(response?.usage?.completion_tokens??response?.usage?.output_tokens)||0};}
  const api={type,endpoint,modelsEndpoint,modelPage,effortOptions,headers,encode,text,usage,effort,reasoning,reasoningHint};
  if(typeof module!=="undefined")module.exports=api;root.ParallelAPI=api;
})(typeof module!=="undefined"&&module.exports?globalThis:this);

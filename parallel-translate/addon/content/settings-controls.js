(function(root){
  'use strict';
  class SettingsSelects {
    constructor(container){
      this.doc=container.ownerDocument;this.win=this.doc.defaultView;this.controls=[];this.listeners=[];this.active=null;this.serial=0;
      this.enhanceAll(container);
      this.on(this.doc,'pointerdown',event=>{if(this.active&&!this.active.menu.contains(event.target)&&!this.active.button.contains(event.target))this.close();});
      this.on(this.doc,'focusin',event=>{if(this.active&&event.target!==this.active.button)this.close();});
      this.on(this.doc,'scroll',event=>{if(this.active&&!this.active.menu.contains(event.target))this.close();},true);
      this.on(this.win,'resize',()=>this.close());
      this.on(this.doc.getElementById('settings-panel'),'toggle',()=>this.close(),true);
    }
    element(tag,cls){const node=this.doc.createElementNS('http://www.w3.org/1999/xhtml',tag);if(cls)node.className=cls;return node;}
    on(node,type,handler,options,control){node.addEventListener(type,handler,options);(control?.listeners||this.listeners).push(()=>node.removeEventListener(type,handler,options));}
    enhanceAll(container){for(const select of container.querySelectorAll('select'))this.enhance(select);}
    enhance(select){
      if(this.controls.some(control=>control.select===select))return;
      if(!select.id)select.id='reader-select-'+(++this.serial);
      const wrapper=this.element('div','settings-select'),button=this.element('button','settings-select-trigger'),label=this.element('span');
      const control={select,button,label,wrapper,menu:null,options:[],index:-1,listeners:[]};this.controls.push(control);
      button.type='button';button.id=select.id+'-trigger';label.id=select.id+'-value';
      button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
      button.setAttribute('aria-controls',select.id+'-menu');button.setAttribute('aria-required',String(select.required));
      const fieldLabel=[...select.labels][0];
      const title=select.getAttribute('aria-label')||(fieldLabel&&[...fieldLabel.childNodes].filter(node=>node!==select).map(node=>node.textContent).join('').trim())||select.id;
      button.setAttribute('aria-label',title);
      if(fieldLabel)this.on(fieldLabel,'click',event=>{if(button.contains(event.target))return;event.preventDefault();button.focus();},undefined,control);
      if(select.hasAttribute('aria-describedby'))button.setAttribute('aria-describedby',select.getAttribute('aria-describedby'));
      button.append(label,root.ParallelIcons.svg('chevron-down',this.doc));select.before(wrapper);wrapper.append(select,button);select.classList.add('settings-native-select');
      this.on(button,'click',()=>this.active===control?this.close():this.open(control),undefined,control);
      this.on(button,'keydown',event=>this.key(control,event),undefined,control);
      this.on(select,'change',()=>this.sync(control),undefined,control);this.on(select,'input',()=>this.sync(control),undefined,control);
      this.on(select,'invalid',event=>{event.preventDefault();button.setAttribute('aria-invalid','true');button.focus();},undefined,control);
      control.observer=new this.win.MutationObserver(()=>{if(this.active===control)this.close();this.sync(control);});
      control.observer.observe(select,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','hidden','label','selected']});
      this.sync(control);
    }
    sync(control){
      const {select,button,label}=control;label.textContent=select.selectedOptions[0]?.label||'请选择';button.title=label.textContent;button.disabled=select.disabled;
      if(select.validity.valid)button.removeAttribute('aria-invalid');
      if(button.disabled&&this.active===control)this.close();
    }
    syncAll(){for(const control of this.controls)this.sync(control);}
    available(control){return control.options.filter(entry=>!entry.disabled);}
    open(control){
      if(control.select.disabled)return;this.close();this.sync(control);
      const menu=this.element('div','settings-select-menu');menu.id=control.select.id+'-menu';menu.setAttribute('role','listbox');
      menu.setAttribute('aria-label',control.button.getAttribute('aria-label'));control.options=[];control.menu=menu;
      for(const option of control.select.options){
        if(option.hidden)continue;
        const item=this.element('div','settings-select-option'),text=this.element('span'),index=control.options.length;
        const disabled=option.disabled||Boolean(option.parentElement?.disabled);text.textContent=option.label;
        item.id=menu.id+'-'+index;item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.setAttribute('aria-disabled',String(disabled));
        item.append(text,root.ParallelIcons.svg('check',this.doc));menu.append(item);control.options.push({option,item,disabled,index});
        item.addEventListener('pointermove',()=>{if(!disabled)this.highlight(control,index,false);});
        item.addEventListener('pointerdown',event=>event.preventDefault());item.addEventListener('click',()=>{if(!disabled)this.choose(control,index);});
      }
      this.doc.body.append(menu);this.active=control;control.button.setAttribute('aria-expanded','true');control.button.focus();
      const bounds=control.button.getBoundingClientRect(),gap=6,below=this.win.innerHeight-bounds.bottom-gap-8,above=bounds.top-gap-8;
      const height=Math.max(40,Math.min(272,Math.max(below,above))),width=Math.min(Math.max(bounds.width,180),this.win.innerWidth-16);
      menu.style.width=width+'px';menu.style.maxHeight=height+'px';menu.style.left=Math.max(8,Math.min(bounds.left,this.win.innerWidth-width-8))+'px';
      if(below>=Math.min(272,menu.scrollHeight)||below>=above)menu.style.top=bounds.bottom+gap+'px';else menu.style.bottom=this.win.innerHeight-bounds.top+gap+'px';
      const chosen=control.options.find(entry=>entry.option.selected&&!entry.disabled)||this.available(control)[0];this.highlight(control,chosen?.index??-1);
    }
    highlight(control,index,scroll=true){
      control.index=index;
      for(const entry of control.options)entry.item.classList.toggle('active',entry.index===index);
      const entry=control.options[index];
      if(entry){control.button.setAttribute('aria-activedescendant',entry.item.id);if(scroll)entry.item.scrollIntoView({block:'nearest'});}
      else control.button.removeAttribute('aria-activedescendant');
    }
    choose(control,index){
      const entry=control.options[index];if(!entry||entry.disabled)return;
      const previous=control.select.selectedIndex;control.select.selectedIndex=entry.option.index;this.sync(control);this.close();control.button.focus();
      if(previous!==control.select.selectedIndex){control.select.dispatchEvent(new this.win.Event('input',{bubbles:true}));control.select.dispatchEvent(new this.win.Event('change',{bubbles:true}));}
    }
    key(control,event){
      if(event.isComposing||event.ctrlKey||event.metaKey||control.select.disabled)return;
      const key=event.key,opened=this.active===control;
      if(key==='Tab'){this.close();return;}
      if(key==='Escape'){if(opened){event.preventDefault();event.stopPropagation();this.close();}return;}
      if(['Enter',' ','ArrowDown','ArrowUp','Home','End'].includes(key)){
        event.preventDefault();event.stopPropagation();
        if(!opened){this.open(control);if(!['Home','End'].includes(key))return;}
        else if(key==='Enter'||key===' '){this.choose(control,control.index);return;}
        const available=this.available(control),current=available.findIndex(entry=>entry.index===control.index);
        const next=key==='Home'?0:key==='End'?available.length-1:Math.max(0,Math.min(available.length-1,current+(key==='ArrowUp'?-1:1)));
        if(available[next])this.highlight(control,available[next].index);return;
      }
      if(key.length===1&&!event.altKey){
        event.preventDefault();event.stopPropagation();if(!opened)this.open(control);
        const now=Date.now();this.query=now-(this.queryTime||0)<800?(this.query||'')+key:key;this.queryTime=now;
        const entry=this.available(control).find(item=>item.option.label.toLocaleLowerCase().startsWith(this.query.toLocaleLowerCase()));
        if(entry)this.highlight(control,entry.index);
      }
    }
    close(){
      if(!this.active)return;const control=this.active;this.active=null;control.menu?.remove();control.menu=null;
      control.button.setAttribute('aria-expanded','false');control.button.removeAttribute('aria-activedescendant');this.query='';this.queryTime=0;
    }
    release(container){
      this.controls=this.controls.filter(control=>{if(!container.contains(control.select))return true;if(this.active===control)this.close();control.observer.disconnect();for(const remove of control.listeners)remove();return false;});
    }
    destroy(){this.close();this.release(this.doc.body);for(const remove of this.listeners)remove();}
  }
  root.ParallelSettingsSelects=SettingsSelects;
})(this);

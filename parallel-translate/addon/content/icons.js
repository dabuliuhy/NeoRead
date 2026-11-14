/* One stroke icon set for every control: same 24-unit grid, 2-unit stroke, currentColor. */
(function(root){
  'use strict';
  const SVG='http://www.w3.org/2000/svg';
  // Path data follows the Lucide icon geometry (ISC licence) so shapes are familiar.
  const shapes={
    close:['M18 6 6 18','m6 6 12 12'],
    trash:['M3 6h18','M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2','M19 6l-.9 13.1A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.9L5 6','M10 11v6','M14 11v6'],
    settings:['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',{circle:[12,12,3]}],
    type:['M4 7V4h16v3','M9 20h6','M12 4v16'],
    maximize:['M8 3H5a2 2 0 0 0-2 2v3','M21 8V5a2 2 0 0 0-2-2h-3','M3 16v3a2 2 0 0 0 2 2h3','M16 21h3a2 2 0 0 0 2-2v-3'],
    minimize:['M8 3v3a2 2 0 0 1-2 2H3','M21 8h-3a2 2 0 0 1-2-2V3','M3 16h3a2 2 0 0 1 2 2v3','M16 21v-3a2 2 0 0 1 2-2h3'],
    'chevron-left':['m15 18-6-6 6-6'],
    'chevron-right':['m9 18 6-6-6-6'],
    'chevron-down':['m6 9 6 6 6-6'],
    comment:['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    external:['M15 3h6v6','M10 14 21 3','M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    image:[{rect:[3,3,18,18,2]},{circle:[9,9,2]},'m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21'],
    table:[{rect:[3,3,18,18,2]},'M3 9h18','M3 15h18','M9 3v18'],
    refresh:['M21 12a9 9 0 1 1-2.64-6.36L21 8','M21 3v5h-5'],
    plus:['M5 12h14','M12 5v14'],
    minus:['M5 12h14'],
    pin:['M12 17v5','M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'],
    undo:['M3 7v6h6','M21 17a9 9 0 0 0-15-6.7L3 13'],
    play:['M7 4v16l13-8z'],
    pause:[{rect:[6,4,4,16,1]},{rect:[14,4,4,16,1]}],
    stop:[{rect:[5,5,14,14,2]}],
    search:[{circle:[11,11,7]},'m21 21-4.3-4.3'],
    edit:['M12 20h9','M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
    check:['M20 6 9 17l-5-5'],
    connection:[{rect:[3,3,18,7,2]},{rect:[3,14,18,7,2]},'M7 6.5h.01','M7 17.5h.01','M11 6.5h6','M11 17.5h6'],
    sliders:['M4 6h5','M13 6h7','M4 18h9','M17 18h3','M9 3v6','M13 15v6','M4 12h11','M19 12h1','M15 9v6'],
    list:['M8 6h13','M8 12h13','M8 18h13','M3 6h.01','M3 12h.01','M3 18h.01'],
    save:['M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z','M7 3v6h10V3','M7 21v-8h10v8'],
    locate:[{circle:[12,12,8]},{circle:[12,12,3]},'M12 2v2','M12 20v2','M2 12h2','M20 12h2'],
    tag:['M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z',{circle:[7.5,7.5,1]}]
  };
  function svg(name,doc=root.document){
    const parts=shapes[name];if(!parts)throw Error('Unknown icon: '+name);
    const node=doc.createElementNS(SVG,'svg');
    for(const [k,v] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false',class:'pt-icon pt-icon-'+name}))node.setAttribute(k,v);
    for(const part of parts){
      let child;
      if(typeof part==='string'){child=doc.createElementNS(SVG,'path');child.setAttribute('d',part);}
      else if(part.circle){child=doc.createElementNS(SVG,'circle');const [cx,cy,r]=part.circle;child.setAttribute('cx',cx);child.setAttribute('cy',cy);child.setAttribute('r',r);}
      else{child=doc.createElementNS(SVG,'rect');const [x,y,w,h,rx]=part.rect;child.setAttribute('x',x);child.setAttribute('y',y);child.setAttribute('width',w);child.setAttribute('height',h);child.setAttribute('rx',rx||0);}
      node.append(child);
    }
    return node;
  }
  // set(): icon-only control (text moves to the accessible name);
  // put(): icon in front of a visible text label.
  function set(button,name){
    const text=button.textContent.trim();
    if(text&&!button.getAttribute('aria-label'))button.setAttribute('aria-label',button.title||text);
    button.replaceChildren(svg(name,button.ownerDocument));button.classList.add('has-icon','icon-only');button.dataset.icon=name;return button;
  }
  function put(button,name){
    button.querySelector(':scope > .pt-icon')?.remove();
    button.prepend(svg(name,button.ownerDocument));button.classList.add('has-icon');button.dataset.icon=name;return button;
  }
  // Static markup declares data-icon; text stays visible when data-icon-text is present.
  function hydrate(scope){for(const node of scope.querySelectorAll('[data-icon]'))if(!node.querySelector(':scope > .pt-icon'))(node.hasAttribute('data-icon-text')?put:set)(node,node.dataset.icon);}
  const api={svg,set,put,hydrate,names:Object.keys(shapes)};
  root.ParallelIcons=api;if(typeof module==='object'&&module.exports)module.exports=api;
  if(root.document?.readyState==='loading')root.document.addEventListener('DOMContentLoaded',()=>hydrate(root.document),{once:true});else if(root.document?.querySelectorAll)hydrate(root.document);
})(typeof module==='object'&&module.exports?globalThis:this);

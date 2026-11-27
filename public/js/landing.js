// Landing page: navegação entre seções e demonstrações interativas.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
const seed=[{id:1,name:'Camiseta básica',price:59.9,stock:12},{id:2,name:'Bolsa casual',price:129.9,stock:5},{id:3,name:'Tênis urbano',price:199.9,stock:8}];let items;try{items=JSON.parse(localStorage.getItem('def-products'))||seed}catch{items=seed}const basket={};const money=n=>n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});function show(id){document.querySelectorAll('main>section').forEach(s=>s.hidden=s.id!==id);render()}function node(tag,t){const n=document.createElement(tag);n.textContent=t;return n}function render(){$("products").replaceChildren();$("inventory").replaceChildren();for(const p of items){if(p.name.toLowerCase().includes($("search").value.toLowerCase())){const c=node('article','');c.className='card';const ph=node('div','');ph.innerHTML="<svg viewBox=\"0 0 120 120\" aria-hidden=\"true\"><path d=\"M25 45 H95 L105 108 H15 Z M42 45 V33 Q60 5 78 33 V45\" fill=\"#d6a078\" stroke=\"#102544\" stroke-width=\"2.5\" stroke-linejoin=\"round\"/></svg>";ph.className='photo';const b=node('button','Adicionar');b.disabled=(basket[p.id]||0)>=p.stock;b.onclick=()=>{basket[p.id]=(basket[p.id]||0)+1;render()};c.append(ph,node('h3',p.name),node('p',money(p.price)),b);$("products").append(c)}$("inventory").append(node('p',p.name+' — '+money(p.price)+' — Estoque: '+p.stock))}$("cart").replaceChildren();let total=0;for(const p of items){const q=basket[p.id]||0;if(q){total+=q*p.price;const line=node('p',q+' × '+p.name+' — '+money(q*p.price)+' ');const b=node('button','Remover');b.onclick=()=>{basket[p.id]--;render()};line.append(b);$("cart").append(line)}}$("cart").append(node('strong','Total: '+money(total)))}$("form").onsubmit=e=>{e.preventDefault();const f=new FormData($("form"));items.push({id:Date.now(),name:String(f.get('name')),price:Number(f.get('price')),stock:Number(f.get('stock'))});localStorage.setItem('def-products',JSON.stringify(items));$("form").reset();render()};async function copyOrder(){const lines=items.filter(p=>basket[p.id]>0).map(p=>basket[p.id]+' × '+p.name+' — '+money(p.price*basket[p.id]));if(!lines.length){$("status").textContent='Adicione produtos primeiro.';return}try{await navigator.clipboard.writeText(lines.join('\n'));$("status").textContent='Pedido copiado.'}catch{$("status").textContent=lines.join(' | ')}}render()
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-show]");
    if (t) { show(t.getAttribute("data-show")); window.scrollTo(0, 0); }
  });
  $("search").addEventListener("input", render);
  $("copyOrder").addEventListener("click", copyOrder);
  $("aiSimulate").addEventListener("click", function () {
    $("aiResult").textContent = "Simulação: " + $("aiMessage").value + " — aguardando revisão do lojista.";
  });
  $("compareRange").addEventListener("input", function () {
    $("after").style.clipPath = "inset(0 " + (100 - this.value) + "% 0 0)";
  });
})();

const $=s=>document.querySelector(s);
function day(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),a=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${a}`;}
const current=new Date();const today=day(current);$('#today').textContent=new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(current);
$('#start').max=today;$('#end').max=today;
function range(months){const d=new Date();const original=d.getDate();d.setDate(1);d.setMonth(d.getMonth()-months);const days=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(original,days));$('#start').value=day(d);$('#end').value=today;}
range(6);
document.querySelectorAll('[data-months]').forEach(b=>b.addEventListener('click',()=>{range(Number(b.dataset.months));document.querySelectorAll('[data-months]').forEach(x=>x.classList.toggle('active',x===b));$('#form-error').textContent='';}));
['#start','#end'].forEach(id=>$(id).addEventListener('input',()=>{document.querySelectorAll('[data-months]').forEach(x=>x.classList.remove('active'));$('#form-error').textContent='';}));
$('#analyze').addEventListener('submit',e=>{e.preventDefault();const symbol=$('#symbol').value.trim(),start=$('#start').value,end=$('#end').value;if(!symbol){$('#form-error').textContent='종목명 또는 코드를 입력해 주세요.';return;}if(start>end){$('#form-error').textContent='시작일이 종료일보다 늦습니다. 날짜를 확인해 주세요.';return;}const url=new URL('https://stock-flow-hkmc.sungs3436.chatgpt.site/');url.search=new URLSearchParams({symbol,start,end});window.location.assign(url.href);});
$('#filter').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();let visible=0;document.querySelectorAll('.card').forEach(card=>{const found=card.dataset.search.toLowerCase().includes(q);card.hidden=!found;if(found)visible++;});$('#empty').hidden=visible!==0;});

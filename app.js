/* ============================================================
   LIDITAX · uma solução Elite Consultoria Contábil
   Front-end do preenchimento de cadastro fiscal de produtos.
   Banco: Supabase (projeto mix-fiscal-elite, região sa-east-1)
   ============================================================ */
const SB_URL  = 'https://mxsznvkksqeogkkgoylo.supabase.co';
const SB_KEY  = 'sb_publishable_U4WfRm7NFfhY86yLHAjPZw_9mFW5Es0';
// O acesso não depende mais do domínio do e-mail: quem libera é o administrador
// do portal, na tela "Acessos". O banco valida a aprovação por RLS.
const sb = supabase.createClient(SB_URL, SB_KEY);

/* nome do produto: troque aqui quando o nome definitivo for escolhido */
const NOME_PRODUTO = {nome:'LidiTax', sub:'Classificação tributária de produtos', arquivo:'liditax'};
document.title = NOME_PRODUTO.nome+' · Elite';
const $  = id => document.getElementById(id);
const norm = s => (s??'').toString().trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const dig  = s => (s??'').toString().replace(/\D/g,'');
const esc  = s => (s??'').toString().replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let toastT=null;
function toast(html, ms=5000){ const t=$('toast'); t.innerHTML=html; t.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'), ms); }

/* estado */
let USER=null, CLIENTES=[], CLIENTE=null, BASE=new Map(), META=new Map(), TIPI=new Set();
let ST=[];   // substituição tributária da UF do cliente (Anexo 007 do RICMS/RN)
let OVERRIDES={};   // fundamento corrigido pela equipe: regra|código original -> novo código
let WB=null, RAW=null, RAWNAME='', SHEET='', HR=0, HEADERS=[], MAPA={}, ITENS=[], FILTRO='all';
let SELECAO=new Set();   // chaves de itens marcados para edição em lote
let ULTIMO_LOTE={replicados:0,total:0};
let TRILHA=[];           // toda alteração feita na sessão, para a aba de correções

/* ============================ AUTENTICAÇÃO ============================ */
$('gateForm').addEventListener('submit', async e=>{
  e.preventDefault(); $('gErr').textContent='';
  const email=$('gEmail').value.trim().toLowerCase(), pass=$('gPass').value;
  $('gBtn').disabled=true;
  const {error} = await sb.auth.signInWithPassword({email, password:pass});
  $('gBtn').disabled=false;
  if(error){ $('gErr').textContent = /Invalid login/i.test(error.message) ? 'Credenciais inválidas.' : error.message; return; }
  entrar();
});
$('gSignup').onclick = async ()=>{
  $('gErr').textContent='';
  const email=$('gEmail').value.trim().toLowerCase(), pass=$('gPass').value;
  if(pass.length<8){ $('gErr').textContent='Defina uma senha com ao menos 8 caracteres.'; return; }
  const {error}=await sb.auth.signUp({email, password:pass});
  if(error){ $('gErr').textContent=error.message; return; }
  $('gErr').textContent='';
  toast('Conta criada. Seu pedido de acesso vai para a aprovação do administrador do portal.', 9000);
};
/* Entrada pela conta Google do escritório (Workspace). O parâmetro hd pede ao
   Google que só ofereça contas do domínio; a checagem final é feita aqui e no
   banco (RLS), porque o hd sozinho não é barreira de segurança. */
$('gGoogle').onclick = async ()=>{
  $('gErr').textContent='';
  const {error} = await sb.auth.signInWithOAuth({
    provider:'google',
    options:{ redirectTo: location.origin + location.pathname,
              queryParams:{ prompt:'select_account' } }
  });
  if(error) $('gErr').textContent = /provider is not enabled/i.test(error.message)
    ? 'O login pelo Google ainda não está habilitado no projeto Supabase (Authentication → Providers → Google).'
    : error.message;
};
/* Recuperação de senha: envia o link e, na volta, pede a nova senha */
$('gReset').onclick = async ()=>{
  const email=$('gEmail').value.trim().toLowerCase();
  $('gErr').textContent='';
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ $('gErr').textContent='Informe seu e-mail acima para receber o link.'; return; }
  const {error} = await sb.auth.resetPasswordForEmail(email,
    {redirectTo: location.origin + location.pathname});
  toast(error ? 'Não foi possível enviar: '+error.message
              : 'Link de recuperação enviado para o seu e-mail. Abra o link nesta mesma máquina.');
};
$('formNovaSenha').addEventListener('submit', async e=>{
  e.preventDefault(); $('nsErr').textContent='';
  const p1=$('nsPass').value, p2=$('nsPass2').value;
  if(p1.length<8){ $('nsErr').textContent='Use ao menos 8 caracteres.'; return; }
  if(p1!==p2){ $('nsErr').textContent='As duas senhas não são iguais.'; return; }
  const {error} = await sb.auth.updateUser({password:p1});
  if(error){ $('nsErr').textContent=error.message; return; }
  $('novaSenha').hidden=true;
  toast('Senha alterada.');
  entrar();
});

/* volta do redirecionamento do Google e do link de recuperação */
sb.auth.onAuthStateChange((evt, session)=>{
  if(evt==='PASSWORD_RECOVERY'){
    $('gate').hidden=true; $('app').hidden=true; $('espera').hidden=true;
    $('novaSenha').hidden=false;
    return;
  }
  if(evt==='SIGNED_IN' && session && !USER && $('novaSenha').hidden) entrar();
});
$('btnSair').onclick = async ()=>{ await sb.auth.signOut(); location.reload(); };

/* Camada 2 de segurança: além do domínio, o cadastro precisa estar aprovado por
   um administrador. O primeiro acesso do domínio assume o papel de admin. */
const SIT_ACESSO = {
  pendente:['Cadastro aguardando aprovação','Seu pedido foi registrado e está na fila do administrador do portal. Você recebe acesso assim que ele aprovar.'],
  negado:  ['Acesso negado','O administrador do portal não autorizou este cadastro. Fale com ele se achar que houve engano.'],
  suspenso:['Acesso suspenso','Este cadastro foi suspenso pelo administrador do portal.']
};
async function verificarAprovacao(origem){
  const {data, error} = await sb.rpc('solicitar_acesso',
    {p_nome: null, p_origem: origem || 'senha'});
  if(error) return {ok:false, erro:error.message};
  const linha = Array.isArray(data)? data[0] : data;
  return {ok: linha && linha.status==='aprovado', linha};
}
function mostrarEspera(status){
  const [titulo, texto] = SIT_ACESSO[status] || SIT_ACESSO.pendente;
  $('gate').hidden=true; $('app').hidden=true; $('espera').hidden=false;
  $('esperaTitulo').textContent = titulo;
  $('esperaTexto').textContent = texto;
}
$('esperaAtualizar').onclick = ()=>entrar();
$('esperaSair').onclick = async ()=>{ await sb.auth.signOut(); location.reload(); };

let EH_ADMIN=false;
async function entrar(){
  const {data:{user}} = await sb.auth.getUser();
  if(!user){ return; }
  const origem = (user.app_metadata && user.app_metadata.provider) || 'senha';
  const ap = await verificarAprovacao(origem==='email'?'senha':origem);
  if(!ap.ok){
    if(ap.erro){ $('gate').hidden=false; $('gErr').textContent='Não foi possível verificar seu acesso: '+ap.erro; return; }
    mostrarEspera(ap.linha? ap.linha.status : 'pendente');
    return;
  }
  EH_ADMIN = ap.linha && ap.linha.papel==='admin';
  USER=user.email;
  $('espera').hidden=true;
  $('gate').hidden=true; $('app').hidden=false;
  $('navAcessos').hidden = !EH_ADMIN;
  $('navCuradoria').hidden = !EH_ADMIN;
  $('whoami').textContent = USER;
  await Promise.all([carregarBase(), carregarClientes()]);
  carregarAtos(); carregarMemoria();
}
sb.auth.getSession().then(({data:{session}})=>{ if(session) entrar(); });

/* ============================ NAVEGAÇÃO ============================ */
document.querySelectorAll('.navitem').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.navitem').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('.tela').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); $('tela-'+b.dataset.tela).classList.add('on');
  if(b.dataset.tela==='atualizacoes'){ carregarAtos(); carregarFontes(); }
  if(b.dataset.tela==='base'){ carregarMemoria(); kpisBase(); }
  if(b.dataset.tela==='acessos') carregarAcessos();
  if(b.dataset.tela==='curadoria') carregarCuradoria();
  if(b.dataset.tela==='familias') montarFamilias();
  if(b.dataset.tela==='diagnostico') montarDiagnostico();
});

/* ============================ DIAGNÓSTICO POR NCM ============================ */
const raizDesc = d => norm(d).split(/\s+/).filter(p=>p.length>=4).slice(0,2).join(' ');
/* para divergência, o substantivo inicial basta: "queijo", "pao", "arroz" */
const VAZIAS=new Set(['para','com','sem','dos','das','por','tipo','und','kit']);
const nucleoDesc = d => (norm(d).split(/\s+/).find(p=>p.length>=3 && !VAZIAS.has(p)) || '');

function montarDiagnostico(){
  if(!ITENS.length){
    $('kpisDiag').innerHTML='';
    $('tbDiagNcm').innerHTML='<tr><td colspan="4" class="muted">Processe uma planilha na tela 1 para ver o diagnóstico.</td></tr>';
    $('tbDiagDiv').innerHTML='<tr><td colspan="3" class="muted">—</td></tr>';
    return;
  }
  // um NCM servindo a muitos produtos distintos
  const porNcm=new Map();
  ITENS.forEach(i=>{ if(!porNcm.has(i.ncm)) porNcm.set(i.ncm,[]); porNcm.get(i.ncm).push(i); });
  const suspeitos=[...porNcm.entries()]
    .map(([ncm,lista])=>({ncm, lista, raizes:new Set(lista.map(x=>raizDesc(x.desc))).size}))
    .filter(x=>x.lista.length>=4 && x.raizes>=3)
    .sort((a,b)=>b.raizes-a.raizes);

  // produtos parecidos com códigos diferentes
  // divergência real: mesma palavra-núcleo caindo em POSIÇÕES diferentes (4 dígitos)
  const porRaiz=new Map();
  ITENS.forEach(i=>{ const r=nucleoDesc(i.desc); if(!r||!i.ncm) return;
    if(!porRaiz.has(r)) porRaiz.set(r,new Map());
    const m=porRaiz.get(r); m.set(i.ncm,(m.get(i.ncm)||0)+1); });
  const divergentes=[...porRaiz.entries()]
    .filter(([,m])=>new Set([...m.keys()].map(c=>c.slice(0,4))).size>1)
    .map(([raiz,m])=>({raiz, codigos:[...m.entries()].sort((a,b)=>b[1]-a[1]), itens:[...m.values()].reduce((a,b)=>a+b,0)}))
    .sort((a,b)=>b.codigos.length-a.codigos.length).slice(0,40);

  const residuais = ITENS.filter(i=>/residual/i.test(i.ncmMsg||'')).length;
  const invalidos = ITENS.filter(i=>i.ncmStatus==='err').length;
  $('kpisDiag').innerHTML=[['k-all',ITENS.length,'Itens'],['k-err',invalidos,'NCM inválido'],
    ['k-rev',residuais,'Código residual'],['k-60',suspeitos.length,'NCM genérico'],
    ['k-mem',divergentes.length,'Produtos divergentes']]
    .map(([c,v,l])=>`<button class="kpi ${c}" disabled><div class="v">${v}</div><div class="l">${l}</div></button>`).join('');

  $('tbDiagNcm').innerHTML = suspeitos.length ? suspeitos.slice(0,30).map(x=>`<tr>
      <td class="mono">${esc(x.ncm)}</td>
      <td class="mono">${x.lista.length}<div class="muted">${x.raizes} produtos distintos</div></td>
      <td class="muted">${esc((x.lista[0].ncmItem||'').replace(/<[^>]+>/g,'').slice(0,54))}</td>
      <td class="muted">${esc(x.lista.slice(0,4).map(i=>i.desc.slice(0,24)).join(' · '))}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="muted">Nenhum NCM concentrando produtos heterogêneos.</td></tr>';

  $('tbDiagDiv').innerHTML = divergentes.length ? divergentes.map(d=>`<tr>
      <td>${esc(d.raiz)}</td>
      <td class="mono">${d.codigos.map(([c,q])=>esc(c)+' ('+q+')').join('  ·  ')}</td>
      <td class="mono">${d.itens}</td>
    </tr>`).join('') : '<tr><td colspan="3" class="muted">Nenhuma divergência encontrada.</td></tr>';
}

/* ============================ ACESSOS (administrador) ============================ */
$('btnRecarregarAcessos').onclick = ()=>carregarAcessos();
const SIT_CHIP = {aprovado:'c-ok', pendente:'c-rev', negado:'c-err', suspenso:'c-intg'};
async function carregarAcessos(){
  const {data, error} = await sb.from('usuario_acesso').select('*').order('solicitado_em',{ascending:false});
  if(error){ $('tbAcessos').innerHTML=`<tr><td colspan="7" class="muted">${esc(error.message)}</td></tr>`; return; }
  const linhas = data||[];
  const c = {total:linhas.length, pendente:0, aprovado:0, negado:0};
  linhas.forEach(l=>{ if(c[l.status]!==undefined) c[l.status]++; });
  $('kpisAcessos').innerHTML = [['k-all',c.total,'Cadastros'],['k-rev',c.pendente,'Aguardando você'],
    ['k-ok',c.aprovado,'Aprovados'],['k-err',c.negado,'Negados']]
    .map(([cl,v,l])=>`<button class="kpi ${cl}" disabled><div class="v">${v}</div><div class="l">${l}</div></button>`).join('');
  $('tbAcessos').innerHTML = linhas.length ? linhas.map(l=>`<tr>
      <td class="mono">${esc(l.email)}</td>
      <td class="muted">${esc(l.origem_login||'—')}</td>
      <td class="mono">${(l.solicitado_em||'').slice(0,10)}</td>
      <td><span class="chip ${SIT_CHIP[l.status]||'c-intg'}">${esc(l.status)}</span></td>
      <td>${l.papel==='admin'?'<span class="chip c-mem">admin</span>':'usuário'}</td>
      <td class="muted">${esc((l.decidido_por||'').split('@')[0]||'—')}</td>
      <td>${l.email===USER ? '<span class="muted">você</span>' : `
        ${l.status!=='aprovado'?`<button class="btn quiet" data-ok="${esc(l.email)}">Aprovar</button>`:''}
        ${l.status!=='negado'  ?`<button class="btn link" data-no="${esc(l.email)}">Negar</button>`:''}`}</td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Nenhum pedido de cadastro ainda.</td></tr>';
  $('tbAcessos').querySelectorAll('button[data-ok]').forEach(b=>b.onclick=()=>decidir(b.dataset.ok,'aprovado'));
  $('tbAcessos').querySelectorAll('button[data-no]').forEach(b=>b.onclick=()=>decidir(b.dataset.no,'negado'));
}
async function decidir(email, status){
  const {error} = await sb.rpc('decidir_acesso', {p_email:email, p_status:status, p_papel:null});
  toast(error ? 'Não foi possível decidir: '+error.message
              : `Cadastro de <b>${esc(email)}</b> ${status==='aprovado'?'aprovado':'negado'}.`);
  carregarAcessos();
}

/* ============================ CURADORIA DAS REGRAS ============================
   Cada trilho tem suas próprias tabelas (est_* e fed_*); a tela só alterna a fonte.
   A decisão passa pela função curar_regra, que confere se quem decide é admin
   e grava autor e data no servidor. */
const CUR_ESPECIES = {estadual:['st','aliquota','reducao','isencao'], federal:['piscofins','ibscbs','ipi','ncm']};
const CUR_ROTULO = {st:'Substituição tributária', aliquota:'Alíquota', reducao:'Redução de BC', isencao:'Isenção',
                    piscofins:'PIS/COFINS', ibscbs:'IBS/CBS', ipi:'IPI', ncm:'NCM'};
const SIT_REGRA = {pendente:'c-rev', aprovada:'c-ok', rejeitada:'c-err'};
let CUR_DADOS = [], CUR_TRECHOS = new Map();
['curTrilho','curSit','curEsp'].forEach(id=>{ const e=$(id); if(e) e.onchange=()=>{ if(id==='curTrilho') $('curEsp').value=''; carregarCuradoria(); }; });
if($('curBusca')) $('curBusca').oninput=()=>tabelaCuradoria();
if($('btnRecarregarCur')) $('btnRecarregarCur').onclick=()=>carregarCuradoria();
function tratamentoRegra(t, r){
  const pc = v => v===null||v===undefined ? '' : String(+v).replace('.',',')+'%';
  if(t==='estadual'){
    if(r.especie==='st') return 'ST'+(r.mva!=null?' · MVA '+pc(r.mva):'');
    if(r.especie==='isencao') return 'Isento';
    if(r.especie==='reducao') return 'Alíq. '+pc(r.aliquota)+' · redução '+pc(r.reducao_bc)+(r.carga!=null?' · carga '+pc(r.carga):'');
    return 'Alíquota '+pc(r.aliquota);
  }
  if(r.especie==='piscofins') return [r.regime?('Regime '+r.regime):'Todos os regimes', 'CST '+(r.cst_pis||'—')+(r.cst_entrada?' / entrada '+r.cst_entrada:''),
     (r.aliquota_pis!=null?'PIS '+pc(r.aliquota_pis):''), (r.aliquota_cofins!=null?'COFINS '+pc(r.aliquota_cofins):''),
     (r.natureza_receita?'nat. '+r.natureza_receita:''), (r.tabela_sped?'Tab. '+r.tabela_sped:'')].filter(Boolean).join(' · ');
  return [r.cclasstrib, r.cst_ibscbs, r.reducao].filter(Boolean).join(' · ');
}
/* ============================ FAMÍLIAS DE PRODUTO ============================
   Família = mesmo NCM + mesmo nome principal da descrição ("ARROZ", "CERVEJA"...).
   A tela mostra onde a família está incoerente e deixa decidir uma vez para todos
   os itens dela, sempre pela prévia do lote (nada é gravado sem confirmar). */
const FAM_CAMPOS = [['ncm','NCM','ncm'],['cest','CEST','cest'],['cst','CST/CSOSN ICMS','cst'],['cclasstrib','cClassTrib','ct'],
                    ['cfop_saida','CFOP saída','cfopS'],['cfop_entrada','CFOP entrada','cfopE']];
let FAMILIAS = [];
if($('famBusca')) $('famBusca').oninput=()=>tabelaFamilias();
if($('famSoDiv')) $('famSoDiv').onchange=()=>tabelaFamilias();
function familiaDe(it){ const n=dig(it.ncm); return (n.length===8?n:'—')+'|'+(nucleoDesc(it.desc||'')||'(sem descrição)'); }
function distintos(itens, prop){ const m=new Map(); itens.forEach(i=>{ const v=String(i[prop]??'').trim(); m.set(v,(m.get(v)||0)+1); });
  return [...m.entries()].sort((a,b)=>b[1]-a[1]); }
function montarFamilias(){
  const tem = ITENS.length>0;
  $('famVazio').hidden = tem; $('famCorpo').hidden = !tem;
  if(!tem) return;
  const g = new Map();
  ITENS.forEach(it=>{ const k=familiaDe(it); if(!g.has(k)) g.set(k,[]); g.get(k).push(it); });
  FAMILIAS = [...g.entries()].map(([k,itens])=>{
    const [ncm,nome]=k.split('|');
    const campos = Object.fromEntries(FAM_CAMPOS.map(([c,,prop])=>[c, distintos(itens,prop)]));
    campos.aliq = distintos(itens,'aliq');
    const diverge = Object.values(campos).some(d=>d.length>1);
    const sug = itens.map(i=>(i.ncmSugs||[])[0]).find(x=>x && x.ncm && x.ncm_unico);
    const incoerentes = itens.filter(i=>i.ncmIncoerente).length;
    return {k, ncm, nome, itens, campos, diverge, incoerentes, sugNcm: sug ? sug.ncm : '',
            pend: itens.filter(i=>i.status==='rev'||i.status==='err').length};
  }).sort((a,b)=> (b.incoerentes-a.incoerentes) || (b.diverge-a.diverge) || (b.itens.length-a.itens.length));
  tabelaFamilias();
}
function tabelaFamilias(){
  const b=norm($('famBusca').value||''), so=$('famSoDiv').checked;
  const L = FAMILIAS.filter(f=>(!so||f.diverge) && (!b || norm(f.nome+' '+f.ncm+' '+f.itens.map(i=>i.desc).join(' ')).includes(b)));
  $('famInfo').textContent = `${L.length} família(s) · ${FAMILIAS.filter(f=>f.diverge).length} com divergência interna`;
  const cel = d => d.length>1 ? `<span class="chip c-rev" title="${esc(d.map(([v,n])=>(v||'(vazio)')+': '+n).join(' · '))}">${d.length} valores</span>`
                             : `<span class="mono">${esc(d[0]&&d[0][0]||'—')}</span>`;
  $('tbFam').innerHTML = L.length ? L.slice(0,400).map((f,ix)=>`<tr>
      <td><b>${esc(f.nome.toUpperCase())}</b><br><span class="muted">${esc((f.itens[0].desc||'').slice(0,60))}${f.itens.length>1?' …':''}</span></td>
      <td class="mono">${esc(f.ncm)}</td><td>${f.itens.length}</td>
      <td>${cel(f.campos.cest)}</td><td>${cel(f.campos.cst)}</td><td>${cel(f.campos.aliq)}</td><td>${cel(f.campos.cclasstrib)}</td>
      <td>${f.incoerentes?`<span class="chip c-err" title="A descrição aponta para outro capítulo da NCM">NCM ≠ descrição</span><br>`:''}${f.pend?`<span class="chip c-rev">${f.pend} a revisar</span>`:'<span class="chip c-ok">ok</span>'}${f.sugNcm?`<div class="muted mono">sugerido ${esc(f.sugNcm)}</div>`:''}</td>
      <td class="fam-vinc"><select data-fam="${esc(f.k)}" class="famCampo">${FAM_CAMPOS.map(([c,r])=>`<option value="${c}">${r}</option>`).join('')}</select>
          <input class="mono famValor" data-fam="${esc(f.k)}" size="9" value="${esc((f.incoerentes||f.ncm==='—') && f.sugNcm ? f.sugNcm : f.campos.ncm[0][0])}">
          <button class="btn quiet famAplicar" data-fam="${esc(f.k)}">Aplicar à família</button></td>
    </tr>`).join('') : '<tr><td colspan="9" class="muted">Nenhuma família nesta seleção.</td></tr>';
  const acha = k=>FAMILIAS.find(f=>f.k===k);
  $('tbFam').querySelectorAll('select.famCampo').forEach(sel=>sel.onchange=()=>{
    const f=acha(sel.dataset.fam), inp=sel.parentElement.querySelector('.famValor');
    inp.value = sel.value==='ncm' && (f.incoerentes||f.ncm==='—') && f.sugNcm ? f.sugNcm
              : (f.campos[sel.value][0]||[''])[0];       // sugere o valor mais comum da família (NCM: o sugerido pela descrição)
  });
  $('tbFam').querySelectorAll('button.famAplicar').forEach(btn=>btn.onclick=async()=>{
    const f=acha(btn.dataset.fam), box=btn.parentElement;
    const campo=box.querySelector('.famCampo').value, valor=box.querySelector('.famValor').value.trim();
    if(!valor){ toast('Informe o valor para a família.'); return; }
    const n = await aplicarEmLote(campo, valor, new Set(f.itens.map(chaveItem)), false);
    toast(n ? `<b>${n}</b> item(ns) da família <b>${esc(f.nome.toUpperCase())}</b> atualizados e gravados na memória.` : 'Nenhuma alteração aplicada.');
    montarFamilias();
  });
}

async function carregarCuradoria(){
  if(!EH_ADMIN) return;
  const t=$('curTrilho').value, sit=$('curSit').value;
  const esp=$('curEsp');
  if(esp.options.length<=1 || esp.dataset.trilho!==t){
    esp.innerHTML='<option value="">Todas as espécies</option>'+CUR_ESPECIES[t].map(e=>`<option value="${e}">${CUR_ROTULO[e]}</option>`).join('');
    esp.dataset.trilho=t;
  }
  const tab = t==='estadual'?'est_regra':'fed_regra';
  CUR_DADOS = await carregarTodos(tab, '*', q=>{ q=q.order('id'); if(sit) q=q.eq('situacao',sit); if(esp.value) q=q.eq('especie',esp.value); return q; });
  // contagem por situação do trilho inteiro
  const todas = await carregarTodos(tab, 'situacao');
  const c={pendente:0,aprovada:0,rejeitada:0}; (todas||[]).forEach(x=>{ if(c[x.situacao]!==undefined) c[x.situacao]++; });
  $('kpisCur').innerHTML=[['k-rev',c.pendente,'Aguardando curadoria'],['k-ok',c.aprovada,'Aprovadas'],['k-err',c.rejeitada,'Rejeitadas']]
    .map(([cl,v,l])=>`<button class="kpi ${cl}" disabled><div class="v">${v}</div><div class="l">${l}</div></button>`).join('');
  tabelaCuradoria();
}
function tabelaCuradoria(){
  const t=$('curTrilho').value, b=norm($('curBusca').value||'');
  const L = CUR_DADOS.filter(r=>!b || norm([r.ncm,r.cest,r.descricao,r.fundamento,r.condicao,r.tabela_sped,r.natureza_receita].join(' ')).includes(b));
  $('curInfo').textContent = L.length+' regra(s)';
  CUR_VISIVEIS = L;
  const pend = L.filter(r=>r.situacao==='pendente').length;
  $('btnCurLote').hidden = !pend;
  $('btnCurLote').textContent = `Aprovar as ${pend} pendente(s) desta lista`;
  const vig = r => (r.vigencia_inicio? r.vigencia_inicio.split('-').reverse().join('/') : '—')+' a '+(r.vigencia_fim? r.vigencia_fim.split('-').reverse().join('/') : 'sem fim');
  $('tbCur').innerHTML = L.length ? L.slice(0,600).map(r=>`<tr>
      <td>${esc(CUR_ROTULO[r.especie]||r.especie)}</td>
      <td class="mono">${esc(r.ncm||'—')}${r.cest?'<br><span class="muted">CEST '+esc(r.cest)+'</span>':''}</td>
      <td>${esc((r.descricao||'').slice(0,90))}${(r.exige&&r.exige.length)?'<br><span class="muted">exige: '+esc(r.exige.join(', '))+'</span>':''}${(r.exclui&&r.exclui.length)?'<br><span class="muted">exclui: '+esc(r.exclui.join(', '))+'</span>':''}</td>
      <td>${esc(tratamentoRegra(t,r))}</td>
      <td>${esc(r.fundamento||'')}${r.condicao?'<br><span class="muted">'+esc(r.condicao.slice(0,180))+'</span>':''}
          ${r.trecho_id?`<br><button class="btn link" data-trecho="${r.trecho_id}">ver trecho do documento</button><div class="trecho" id="tr-${t}-${r.id}" hidden></div>`:''}</td>
      <td class="mono">${vig(r)}</td>
      <td><span class="chip ${SIT_REGRA[r.situacao]||'c-intg'}">${esc(r.situacao)}</span>${r.curado_por?'<br><span class="muted">'+esc(r.curado_por.split('@')[0])+' · '+String(r.curado_em||'').slice(0,10)+'</span>':''}</td>
      <td>${r.situacao!=='aprovada'?`<button class="btn quiet" data-cur="aprovada" data-id="${r.id}">Aprovar</button>`:''}
          ${r.situacao!=='rejeitada'?`<button class="btn link" data-cur="rejeitada" data-id="${r.id}">Rejeitar</button>`:''}
          ${r.situacao!=='pendente'?`<button class="btn link" data-cur="pendente" data-id="${r.id}">Voltar a pendente</button>`:''}</td>
    </tr>`).join('') + (L.length>600?`<tr><td colspan="8" class="muted">Mostrando 600 de ${L.length}. Use a busca para refinar.</td></tr>`:'')
    : '<tr><td colspan="8" class="muted">Nenhuma regra nesta seleção.</td></tr>';
  $('tbCur').querySelectorAll('button[data-cur]').forEach(btn=>btn.onclick=()=>curar(+btn.dataset.id, btn.dataset.cur));
  $('tbCur').querySelectorAll('button[data-trecho]').forEach(btn=>btn.onclick=async()=>{
    const box=btn.nextElementSibling; if(!box) return;
    if(!box.hidden){ box.hidden=true; return; }
    const id=+btn.dataset.trecho, chave=t+'|'+id;
    if(!CUR_TRECHOS.has(chave)){
      const {data} = await sb.from(t==='estadual'?'est_trecho':'fed_trecho').select('referencia,texto,marca,pagina').eq('id',id).maybeSingle();
      CUR_TRECHOS.set(chave, data);
    }
    const tr=CUR_TRECHOS.get(chave);
    box.innerHTML = tr ? `<b>${esc(tr.referencia||'')}</b>${tr.pagina?' · pág. '+tr.pagina:''}${tr.marca?' · '+esc(tr.marca):''}<br>${esc(tr.texto||'')}` : 'Trecho não encontrado.';
    box.hidden=false;
  });
}
let CUR_VISIVEIS = [];
if($('btnCurLote')) $('btnCurLote').onclick = async ()=>{
  const t=$('curTrilho').value, ids=CUR_VISIVEIS.filter(r=>r.situacao==='pendente').map(r=>r.id);
  if(!ids.length) return;
  // prévia: mostra o que vai ser aprovado antes de gravar
  $('pvTitulo').textContent = `Aprovar ${ids.length} regra(s) do trilho ${t}?`;
  $('pvResumo').innerHTML = 'Cada regra passa a valer no próximo processamento de planilha. Você pode devolver qualquer uma a pendente depois.';
  $('pvLinhas').innerHTML = CUR_VISIVEIS.filter(r=>r.situacao==='pendente').slice(0,12).map(r=>`<tr><td>${esc((r.descricao||'').slice(0,46))}</td>
      <td class="mono">${esc(r.ncm||r.cest||'—')}</td><td>${esc(tratamentoRegra(t,r)).slice(0,40)}</td><td class="mono">${esc((r.fundamento||'').slice(0,30))}</td></tr>`).join('');
  $('pvMais').textContent = ids.length>12 ? `e mais ${ids.length-12} regra(s).` : '';
  $('pvMemoria').hidden = true; $('pvReplicarBox').hidden = true; $('previa').hidden=false;
  const ok = await new Promise(res=>{ $('pvConfirmar').onclick=()=>res(true); $('pvCancelar').onclick=()=>res(false); });
  $('previa').hidden=true; $('pvConfirmar').onclick=$('pvCancelar').onclick=null;
  if(!ok) return;
  const {data,error} = await sb.rpc('curar_regras',{p_trilho:t, p_ids:ids, p_situacao:'aprovada'});
  if(error){ toast('Não foi possível aprovar: '+esc(error.message)); return; }
  toast(`<b>${data??ids.length}</b> regra(s) aprovada(s). Valem a partir do próximo processamento.`);
  await carregarCuradoria(); carregarBase();
};
async function curar(id, situacao){
  const t=$('curTrilho').value;
  let nota=null;
  if(situacao==='rejeitada'){ nota = prompt('Motivo da rejeição (fica registrado):',''); if(nota===null) return; }
  const {error} = await sb.rpc('curar_regra',{p_trilho:t, p_id:id, p_situacao:situacao, p_nota:nota});
  if(error){ toast('Não foi possível registrar: '+esc(error.message)); return; }
  toast(`Regra <b>${id}</b> marcada como <b>${situacao}</b>. Ela ${situacao==='aprovada'?'passa a valer':'deixa de valer'} no próximo processamento.`);
  await carregarCuradoria();
  carregarBase();   // recarrega as regras em uso
}

/* ============================ BASE DE REFERÊNCIA ============================ */
/* A API do Supabase devolve no máximo 1.000 linhas por consulta: tabelas grandes vêm em páginas. */
async function carregarTodos(tabela, colunas, filtro){
  const out=[];
  for(let de=0; de<200000; de+=1000){
    let q = sb.from(tabela).select(colunas).range(de, de+999);
    if(filtro) q = filtro(q);
    const {data, error} = await q;
    if(error){ console.warn(tabela, error); break; }
    out.push(...(data||[]));
    if(!data || data.length<1000) break;
  }
  return out;
}

/* ---------- Descrição × NCM ----------
   Sugestão pela descrição do produto (função sugerir_ncm_lote no banco): léxico montado da
   nomenclatura oficial, das descrições do Anexo 007 do RICMS/RN e de sinônimos comerciais.
   Uso: (1) NCM vazio ou inexistente → preenche só quando a sugestão é forte e aponta um código único;
        (2) NCM válido → se a descrição aponta com força para outro capítulo, sinaliza para conferência.
   Um NCM válido nunca é trocado sozinho. */
async function sugestoesPorDescricao(descricoes){
  const unicas=[...new Set(descricoes.filter(Boolean))], mapa=new Map();
  for(let i=0;i<unicas.length;i+=250){
    const lote=unicas.slice(i,i+250);
    const {data, error} = await sb.rpc('sugerir_ncm_lote', {p_descricoes:lote, p_limite:3});
    if(error){ console.warn('sugerir_ncm_lote', error); break; }
    (data||[]).forEach(r=>{ const d=lote[r.idx-1]; if(!mapa.has(d)) mapa.set(d,[]); mapa.get(d).push(r); });
  }
  return mapa;
}
const fmtNcm = n => n && n.length===8 ? n.slice(0,4)+'.'+n.slice(4,6)+'.'+n.slice(6) : (n&&n.length===4 ? n.slice(0,2)+'.'+n.slice(2) : (n||''));
const FONTE_SUG = {cest_rn:'descrição do Anexo 007 do RICMS/RN', cest_nacional:'descrição do CEST no Conv. ICMS 142/2018', nomenclatura:'nomenclatura oficial (NCM)', memoria:'memória da equipe'};
function avaliarDescricaoNcm(item, sugs){
  if(!sugs || !sugs.length || !ESCOPO.ncm) return;
  const [a, b] = sugs;
  item.ncmSugs = sugs;
  const n = dig(item.ncm||'');
  const texto = s => `${s.ncm_unico && s.ncm ? fmtNcm(s.ncm) : 'posição '+fmtNcm(s.posicao)} — ${String(s.texto||'').replace(/^[-\s]+/,'').slice(0,70)}`;
  if(n.length!==8 || item.ncmStatus==='err'){
    const folga = !b || b.posicao===a.posicao || (a.pontuacao - b.pontuacao) >= 0.3;
    if(a.forte && a.ncm_unico && a.ncm && folga && (TIPI.size<8000 || TIPI.has(a.ncm))){
      item.ncmTroca = item.ncm || item.ncmOrig || '(em branco)';
      item.ncm = a.ncm; item.ncmStatus='rev'; item.ncmPorDescricao=true;
      item.ncmMsg = `NCM ${n? 'inválido' : 'em branco'} — sugerido pela descrição (${FONTE_SUG[a.fonte]||a.fonte}): ${texto(a)}. Confira`;
    } else {
      item.ncmMsg = [item.ncmMsg, `A descrição sugere ${sugs.slice(0,2).map(texto).join(' ou ')} — escolha no painel de revisão`].filter(Boolean).join(' · ');
    }
    return;
  }
  const caps = new Set(sugs.slice(0,2).map(s=>s.posicao.slice(0,2)));
  if(a.forte && (a.fonte==='cest_rn' || a.pontuacao>=2.0) && !caps.has(n.slice(0,2)) && item.ncmStatus!=='mem'){
    item.ncmIncoerente = true;
    if(item.ncmStatus==='ok') item.ncmStatus='rev';
    item.ncmMsg = [item.ncmMsg, `NCM ${fmtNcm(n)} pode não corresponder à descrição: ela aponta para ${texto(a)} (${FONTE_SUG[a.fonte]||a.fonte}) — confira`].filter(Boolean).join(' · ');
  }
}

/* Referências de apoio (tabelasfiscais.com.br, não oficial): CEST do Conv. ICMS
   142/2018 com os NCM de cada CEST e a tabela de CFOP. Servem para sugerir e
   conferir — nunca para declarar erro, porque a lista de NCM por CEST é
   incompleta em alguns casos (ex.: água mineral sem 2201.90.00). */
const CEST_NAC = new Map(); let CEST_NCM = []; const CFOP_TAB = new Map();
async function carregarReferencias(){
  const [cs, cn, cf] = await Promise.all([
    carregarTodos('cest_nacional','cest,descricao,segmento', q=>q.order('cest')),
    carregarTodos('cest_nacional_ncm','cest,ncm', q=>q.order('cest').order('ncm')),
    carregarTodos('cfop_tabela','cfop,descricao', q=>q.order('cfop'))]);
  CEST_NAC.clear(); cs.forEach(r=>CEST_NAC.set(r.cest, r));
  CEST_NCM = cn.filter(r=>CEST_NAC.has(r.cest));
  CFOP_TAB.clear(); cf.forEach(r=>CFOP_TAB.set(r.cfop, r.descricao));
}
const fmtCest = c => c && c.length===7 ? `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5)}` : c;
const PAL_CEST_NAO = new Set(['outros','outras','para','com','sem','uso','exceto','inclusive','produtos','artigos','tipo','qualquer','destinados','destinadas','partes','acessorios']);
const palavrasCest = t => new Set(norm(t).split(/[^a-z0-9]+/).filter(p=>p.length>=4 && !PAL_CEST_NAO.has(p)).map(p=>p.replace(/(oes|aes)$/,'ao').replace(/s$/,'')));
/* CEST nacionais cujo NCM (ou prefixo) abrange o NCM do item; separa os que a descrição confirma. */
function cestNacionalDoItem(ncm, desc){
  const n = dig(ncm); if(n.length!==8 || !CEST_NCM.length) return {todos:[], casam:[]};
  const cods = [...new Set(CEST_NCM.filter(r=>n.startsWith(r.ncm)).map(r=>r.cest))];
  const todos = cods.map(c=>CEST_NAC.get(c)).filter(c=>c && !String(c.segmento||'').startsWith('28'));   // 28: venda porta a porta
  const pd = palavrasCest(desc);
  // palavras depois de "exceto" descrevem o que o CEST NÃO abrange — não servem para casar
  const abrange = t => String(t||'').replace(/\(\s*exceto[^)]*\)/gi,' ').replace(/,?\s*exceto\b.*$/i,' ');
  const casam = todos.filter(c=>[...palavrasCest(abrange(c.descricao))].some(p=>pd.has(p)));
  return {todos, casam};
}
/* CFOP: confere existência e sentido (saída 5/6/7, entrada 1/2/3). */
function conferirCfop(cfop, sentido){
  const c = dig(cfop); if(!c || !CFOP_TAB.size) return '';
  if(c.length!==4 || !CFOP_TAB.has(c)) return `CFOP ${cfop} não existe na tabela de CFOP`;
  if(sentido==='saida' && !'567'.includes(c[0])) return `CFOP ${cfop} é de entrada, mas está na coluna de saída`;
  if(sentido==='entrada' && !'123'.includes(c[0])) return `CFOP ${cfop} é de saída, mas está na coluna de entrada`;
  return '';
}

async function carregarBase(){
  const [{data:anexos}, {data:metas}] = await Promise.all([
    carregarTodos('ibs_cbs_anexo','ncm,cclasstrib,cst,exige,exclui,condicao', q=>q.order('id')).then(data=>({data})),
    sb.from('cclasstrib_meta').select('*')
  ]);
  BASE.clear(); META.clear();
  (anexos||[]).forEach(r=>{ if(!BASE.has(r.ncm)) BASE.set(r.ncm,[]); BASE.get(r.ncm).push(r); });
  (metas||[]).forEach(m=>META.set(m.cclasstrib,m));
  const tipi = await carregarTodos('tipi','ncm', q=>q.order('ncm'));
  TIPI.clear(); tipi.forEach(r=>TIPI.add(String(r.ncm).trim()));
  await carregarReferencias().catch(e=>console.warn('referências CEST/CFOP:',e));
  await carregarOverrides();
  await Promise.all([carregarST(), carregarRegrasICMS().catch(e=>console.warn('regras ICMS:',e)),
                     carregarRegrasPisCofins().catch(e=>console.warn('regras PIS/COFINS:',e))]);
  kpisBase();
}
function kpisBase(){
  const el=$('kpisBase'); if(!el) return;
  el.innerHTML = [
    ['k-all', BASE.size, 'NCMs na base IBS/CBS'],
    ['k-ok',  TIPI.size, 'NCMs na TIPI'],
    ['k-mem', META.size, 'Códigos cClassTrib'],
    ['k-60',  CLIENTES.length, 'Clientes cadastrados']
  ].map(([c,v,l])=>`<button class="kpi ${c}" disabled><div class="v">${v}</div><div class="l">${l}</div></button>`).join('');
}

/* Regra de fundamento: quando a equipe corrige um enquadramento, a decisão vale
   para todos os itens que caíram pela mesma regra — inclusive em planilhas
   futuras. É a replicação que existia antes e que eu havia perdido. */
async function carregarOverrides(){
  const {data} = await sb.from('fundamento_override').select('*').eq('campo','cclasstrib').limit(2000);
  OVERRIDES={};
  (data||[]).forEach(r=>{ OVERRIDES[r.regra+'|'+r.valor_origem]={valor:r.valor_novo, por:r.usuario, quando:r.criado_em}; });
}

async function carregarST(){
  const uf = (CLIENTE && CLIENTE.uf) || 'RN';
  // trilho estadual: só regra aprovada e dentro da vigência
  const nova = await carregarTodos('est_regra_vigente','cest,ncm,descricao,fundamento,vigencia_inicio,trecho_id,mva',
    q=>q.eq('uf',uf).eq('especie','st').order('id'));
  let linhas = (nova||[]).filter(x=>x.ncm).map(x=>({...x, segmento:(x.cest||'').slice(0,2),
                 fundamento: x.fundamento + (x.vigencia_inicio? ' — vigente desde '+x.vigencia_inicio.split('-').reverse().join('/') : '')}));
  ST_FONTE = 'trilho estadual';
  if(!linhas.length){       // UF ainda sem carga no trilho novo: usa a base anterior
    const data = await carregarTodos('st_uf','cest,ncm,descricao,segmento,fundamento', q=>q.eq('uf',uf).order('id'));
    linhas = data||[]; ST_FONTE = 'base anterior';
  }
  ST = linhas.sort((a,b)=>b.ncm.length-a.ncm.length);   // mais específico primeiro
}

/* ---------- ICMS do produto: isenção, redução de BC e alíquota interna (trilho estadual) ---------- */
let REGRAS_ICMS = [], MVA = [], ST_FONTE = '';
async function carregarRegrasICMS(){
  const uf = (CLIENTE && CLIENTE.uf) || 'RN';
  const data = await carregarTodos('est_regra_vigente','especie,ncm,descricao,aliquota,reducao_bc,carga,operacao,exige,exclui,condicao,fundamento',
    q=>q.eq('uf',uf).in('especie',['aliquota','reducao','isencao']).order('id'));
  REGRAS_ICMS = (data||[]).filter(r=>r.operacao!=='interestadual' && (r.ncm || (r.exige&&r.exige.length)));
  const {data:mv} = await sb.from('st_mva').select('produto,mva_original,mva_ajustada,aliquota_interestadual,fundamento').eq('uf',uf).limit(1000);
  MVA = (mv||[]).map(m=>({...m,
    cests:(m.produto.match(/\d{2}\.\d{3}\.\d{2}/g)||[]).map(c=>c.replace(/\./g,'')),
    ncms:(m.produto.match(/NCM\s*([\d\.]{4,10})/gi)||[]).map(x=>x.replace(/\D/g,''))}));
}
const PESO_ICMS = {isencao:3, reducao:2, aliquota:1};
function icmsDoItem(item, cliente){
  const simples = cliente && (cliente.regime==='simples' || cliente.opcao_simples);
  const d = norm(item.desc||''), ncm = item.ncm||'';
  const cand = REGRAS_ICMS.filter(r=>{
    if(r.ncm && !ncm.startsWith(r.ncm)) return false;
    if(r.exige && r.exige.length && !r.exige.some(t=>d.includes(t))) return false;
    if(r.exclui && r.exclui.length && r.exclui.some(t=>d.includes(t))) return false;
    return true;
  }).sort((a,b)=> (b.ncm||'').length-(a.ncm||'').length
              || ((b.exige&&b.exige.length)?1:0)-((a.exige&&a.exige.length)?1:0)
              || PESO_ICMS[b.especie]-PESO_ICMS[a.especie]);
  const r = cand[0];
  const modal = REGRAS_ICMS.find(x=>x.especie==='aliquota' && !x.ncm && !(x.exige&&x.exige.length) && +x.aliquota===20);
  const out = {aliq:'20', red:'', especie:'aliquota', cst:'000',
               fund: 'Alíquota modal — Art. 29, I, "a", do RICMS/RN'};
  if(r){
    out.especie = r.especie;
    out.fund = r.fundamento + (r.condicao ? ' — '+r.condicao : '');
    if(r.especie==='isencao'){ out.aliq='0'; out.cst='040'; }
    else if(r.especie==='reducao'){ out.aliq=String(+r.aliquota||20); out.red=String(+r.reducao_bc); out.cst='020'; }
    else { out.aliq=String(+r.aliquota); out.cst='000'; }
  }
  if(simples){ out.aliq=''; out.red=''; out.fund='Simples Nacional: ICMS pelo DAS · '+out.fund; }
  return out;
}
function mvaDoCest(cest){
  if(!cest) return '';
  // trilho estadual: MVA original conferida no Anexo 007 vigente, gravada na própria regra de ST
  const r = ST.find(x=>x.cest===cest && x.mva!==null && x.mva!==undefined);
  if(r) return String(+r.mva);
  if(ST_FONTE==='trilho estadual' || !MVA.length) return '';
  const m = MVA.find(x=>x.cests.includes(cest));
  return m ? String(+m.mva_original) : '';
}

/* ---------- PIS/COFINS do produto (trilho federal — EFD-Contribuições) ----------
   Regra geral por regime (Lei 10.637/2002 e 10.833/2003 no Real; Lei 9.715/1998 e
   9.718/1998 no Presumido) e exceções por NCM das tabelas 4.3.10 a 4.3.17.
   Só entra regra aprovada na curadoria e dentro da vigência (fed_regra_vigente).
   A partir de 01/01/2027 PIS e Cofins deixam de existir (ADCT, art. 126, II). */
let REGRAS_PC = [];
async function carregarRegrasPisCofins(){
  const data = await carregarTodos('fed_regra_vigente','ncm,regime,cst_pis,cst_cofins,cst_entrada,aliquota_pis,aliquota_cofins,natureza_receita,tabela_sped,exige,exclui,condicao,fundamento,atividade,ncm_exclui,automatico,codigo_origem',
    q=>q.eq('especie','piscofins').order('id'));
  REGRAS_PC = (data||[]).sort((a,b)=>(b.ncm||'').length-(a.ncm||'').length);
  const {data:docs} = await sb.from('fed_documento').select('numero').eq('tipo','tabela_sped');
  TABELAS_PC = (docs||[]).map(d=>d.numero);
}
let TABELAS_PC = [];
const PC_FIM = new Date('2027-01-01T00:00:00-03:00');
const pcExtinto = ()=> new Date() >= PC_FIM;
const TEM_EXCECOES_PC = ()=> REGRAS_PC.some(r=>r.ncm);
// sem as exceções por NCM, a regra geral daria CST 01 a produto monofásico ou de alíquota zero:
// por isso PIS/Cofins só é preenchido depois que as tabelas 4.3.10 a 4.3.17 estiverem carregadas
const pcAtivo = ()=> !pcExtinto() && TEM_EXCECOES_PC();
// Tabela de CST de PIS/COFINS (Guia Prático da EFD-Contribuições): saída → entrada correspondente
const CST_PC_ENTRADA = {'01':'50','02':'50','03':'50','04':'70','05':'75','06':'73','07':'71','08':'74','09':'72'};
const CST_PC_ROTULO = {'01':'Tributável — alíquota básica','02':'Tributável — alíquota diferenciada',
  '03':'Tributável — por unidade de medida','04':'Monofásica — revenda a alíquota zero','05':'Substituição tributária',
  '06':'Alíquota zero','07':'Isenta','08':'Sem incidência','09':'Suspensão','49':'Outras operações de saída'};
function regimeFederal(cliente){
  if(!cliente) return '';
  if(cliente.regime==='simples' || cliente.opcao_simples || cliente.opcao_mei) return 'simples';
  if(cliente.regime==='real') return 'real';
  if(cliente.regime==='presumido' || cliente.regime==='arbitrado') return 'presumido';
  return '';
}
const pcNum = v => (v===null || v===undefined || v==='') ? '' : String(+v).replace('.',',');
function atividadeCliente(cliente){
  if(ehIndustria(cliente)) return 'industria';
  return 'comercio';
}
const ehVarejista = cliente => dig((cliente && cliente.cnae_principal) || '').slice(0,2)==='47';
function excecaoPisCofins(item, cliente){
  const reg = regimeFederal(cliente), ncm = dig(item.ncm||''), d = norm(item.desc||'');
  const ativ = atividadeCliente(cliente);
  return REGRAS_PC.find(r=> r.ncm && ncm.startsWith(r.ncm) && (!r.regime || r.regime===reg)
      && (!r.atividade || r.atividade===ativ || (r.atividade==='varejo' && ativ==='comercio' && ehVarejista(cliente)))
      && !(r.ncm_exclui && r.ncm_exclui.some(x=>ncm.startsWith(x)))
      && !(r.exige && r.exige.length && !r.exige.some(t=>d.includes(t)))
      && !(r.exclui && r.exclui.length && r.exclui.some(t=>d.includes(t))));
}
function pisCofinsDoItem(item, cliente){
  const out = {cst:'', cstE:'', aliqPis:'', aliqCofins:'', nat:'', trib:'', fund:'', rev:'', regra:null};
  if(pcExtinto()){ out.fund='PIS/Cofins extintos a partir de 01/01/2027 (EC 132/2023 — ADCT, art. 126, II): campos não preenchidos'; return out; }
  if(!TEM_EXCECOES_PC()){ out.fund='PIS/Cofins aguardando a carga das tabelas 4.3.10 a 4.3.17 da EFD-Contribuições (exceções por NCM)'; return out; }
  const reg = regimeFederal(cliente);
  if(dig(item.ncm||'').length!==8) return out;
  const exc = excecaoPisCofins(item, cliente);
  out.regra = exc || null;
  if(exc && exc.automatico===false) out.rev = 'PIS/Cofins: '+(exc.condicao||'regra condicional')+'';
  if(exc && exc.atividade==='varejo') out.rev = (out.rev?out.rev+' · ':'')+'PIS/Cofins: alíquota zero só se o cliente for varejista (≥ 75% da receita a consumidor final no ano anterior)';
  // motocicletas (MP 2.158-35/2001, art. 43) e cigarros (Lei 9.532/1997, art. 53) têm PIS/Cofins por substituição
  // tributária — tabela 4.3.12 (CST 05); enquanto ela não for carregada, o item vai para conferência
  const n8 = dig(item.ncm||'');
  if(!exc && !REGRAS_PC.some(r=>r.tabela_sped==='4.3.12') && (n8.startsWith('8711') || n8.startsWith('2402')))
    out.rev = 'PIS/Cofins: produto com substituição tributária das contribuições (tabela 4.3.12, CST 05), tabela ainda não carregada — conferir';
  // regra que só vale para varejista e o CNAE do cliente não é de varejo: fica a regra geral, mas avisa
  const soVarejo = !exc && REGRAS_PC.find(r=>r.ncm && r.atividade==='varejo' && n8.startsWith(r.ncm));
  if(soVarejo) out.rev = 'PIS/Cofins: o código '+soVarejo.natureza_receita+' da tabela '+soVarejo.tabela_sped
      +' só vale para comerciante varejista e o CNAE principal do cliente não é de varejo — aplicada a regra geral; conferir';
  if(reg==='simples'){
    if(exc && exc.cst_pis==='04'){ out.trib='Monofásica — segregar a receita no PGDAS-D'; out.nat=exc.natureza_receita||''; }
    else if(exc && exc.cst_pis==='06'){ out.trib='Alíquota zero (código '+(exc.natureza_receita||'')+' da tabela 4.3.13) — conferir o tratamento no PGDAS-D'; out.nat=exc.natureza_receita||''; }
    else out.trib='Tributado no DAS';
    out.fund = 'Simples Nacional: PIS/Cofins recolhidos no DAS (LC 123/2006, art. 13, IV e V)' + (exc ? ' · '+exc.fundamento : '');
    return out;
  }
  const r = exc || REGRAS_PC.find(x=>!x.ncm && x.regime===reg);
  if(!r){
    out.fund = reg ? 'Regra geral de PIS/Cofins do '+(reg==='real'?'Lucro Real':'Lucro Presumido')+' ainda não aprovada na curadoria'
                   : 'Regime tributário do cliente não informado — PIS/Cofins não preenchidos';
    return out;
  }
  out.cst = r.cst_pis||'';
  // entrada: na revenda monofásica o Presumido e o Real não têm crédito (CST 70); alíquota zero na aquisição → 73
  out.cstE = r.cst_entrada || CST_PC_ENTRADA[out.cst] || '';
  if(exc && exc.cst_pis==='02') out.cstE = '';            // indústria: a entrada depende do insumo, não do produto vendido
  if(!exc && reg==='presumido') out.cstE = '70';
  out.aliqPis = pcNum(r.aliquota_pis ?? (exc?0:'')); out.aliqCofins = pcNum(r.aliquota_cofins ?? (exc?0:''));
  out.nat = r.natureza_receita||'';
  out.trib = CST_PC_ROTULO[out.cst] || '';
  out.fund = r.fundamento + (r.tabela_sped && !String(r.fundamento).includes('Tabela') ? ' — Tabela '+r.tabela_sped+' da EFD-Contribuições' : '');
  return out;
}

/* ---------- Estoque de abertura da CBS em 01/01/2027 (NT EFD-Contribuições 013/2026) ----------
   Código da tabela "Descrição do Estoque de Abertura da CBS" (Anexo V da NT — conteúdo
   inicialmente previsto), usado no campo 13 do registro F150, a escriturar até junho/2027.
   Regra do art. 381 da LC 214/2025, como descrita na NT: */
const ESTAB_FIM = new Date('2027-07-01T00:00:00-03:00');
const estAbAtivo = ()=> TEM_EXCECOES_PC() && new Date() < ESTAB_FIM;
const ESTAB_ROTULO = {'1':'Bens nacionais — estoque do regime cumulativo','2':'Bens importados — estoque do regime cumulativo',
  '5':'Bens nacionais — monofásico/ST na aquisição — medicamentos','6':'Bens nacionais — monofásico/ST na aquisição — veículos, autopeças, pneus e câmaras',
  '7':'Bens nacionais — monofásico/ST na aquisição — motocicletas','8':'Bens nacionais — monofásico/ST na aquisição — cigarros'};
function estoqueAbertura(item, cliente, pc){
  const out={cod:'', fund:'', rev:''};
  if(!estAbAtivo() || dig(item.ncm||'').length!==8) return out;
  const reg = regimeFederal(cliente), ncm=dig(item.ncm), exc = pc && pc.regra;
  const origem = (dig(item.cstOrig||'')+'').length===3 ? dig(item.cstOrig)[0] : '';
  const importado = origem==='1' || origem==='6';
  const base = 'NT EFD-Contribuições 013/2026, registro F150 e Anexo V (conteúdo inicialmente previsto); LC 214/2025, art. 381';
  if(reg==='simples'){ out.fund='Simples Nacional: crédito do estoque de abertura só para quem optar pelo regime regular do IBS/CBS — '+base; return out; }
  if(ehIndustria(cliente) && reg==='real'){ out.fund='Indústria no Lucro Real: estoque já gerou crédito básico — '+base; return out; }
  // aquisição com alíquota zero, isenção, suspensão ou sem incidência não dá crédito presumido
  // alíquota zero da 4.3.13 vale para toda a cadeia: a aquisição também foi a zero → sem crédito
  if(exc && exc.cst_pis==='06'){ out.cod='—'; out.fund='Sem crédito presumido: aquisição com alíquota zero (código '+(exc.natureza_receita||'')+' da tabela 4.3.13) — '+base; return out; }
  // isenção, suspensão e não incidência da tabela dependem da operação de venda: a aquisição pode ter sido tributada
  if(exc && ['07','08','09'].includes(exc.cst_pis))
    out.rev='Estoque de abertura: confirmar se a aquisição deste item foi tributada (a '+(CST_PC_ROTULO[exc.cst_pis]||'').toLowerCase()+' da tabela '+exc.tabela_sped+' trata da venda); aquisição com isenção, suspensão ou sem incidência não dá crédito presumido';
  if(reg==='presumido'){
    out.cod = importado ? '2' : '1';
    out.fund = ESTAB_ROTULO[out.cod]+' — '+base;
    if(importado) out.rev='Estoque de abertura: origem de importação direta pelo CST do ICMS — confirmar e usar o valor efetivamente pago de PIS/Cofins-Importação';
    return out;
  }
  if(reg==='real'){
    let cod='';
    const tab = exc && exc.tabela_sped, co = exc && exc.codigo_origem;
    if(tab==='4.3.10' && co==='201') cod='5';
    else if(tab==='4.3.10' && co==='202'){ cod='5'; out.rev='Estoque de abertura: a NT descreve o código 5 como "Medicamentos (inciso I do art. 1º da Lei 10.147/2000)"; o inciso I também abrange perfumaria — confirmar se este item entra'; }
    else if(tab==='4.3.10' && ['301','302','303','304'].includes(co)) cod='6';
    else if(tab==='4.3.12' && co==='201') cod='7';
    else if(tab==='4.3.12' && co==='301'){ cod='7'; out.rev='Estoque de abertura: o código 7 da NT cita o art. 43 da MP 2.158-35/2001 (que também alcança o 8432.30), mas descreve só motocicletas — conferir'; }
    else if(tab==='4.3.12' && co==='101') cod='8';
    else if(tab==='4.3.12' && co==='102'){ cod='8'; out.rev='Estoque de abertura: a NT descreve o código 8 como cigarros (art. 53 da Lei 9.532/1997); cigarrilhas estão no art. 6º da Lei 12.402/2011 — conferir'; }
    else if(!exc && ncm.startsWith('8711')) cod='7';
    else if(!exc && ncm.startsWith('240220')){ cod='8'; out.rev='Estoque de abertura: cigarros pela NCM 2402.20 da TIPI — conferir'; }
    if(!cod){ out.fund='Lucro Real: mercadoria com crédito básico na aquisição, sem crédito presumido de estoque — '+base; return out; }
    if(importado){ out.rev=(out.rev?out.rev+' · ':'')+'Estoque de abertura: os códigos 5 a 8 são para bens nacionais e o CST do ICMS indica importação direta — conferir'; }
    out.cod=cod; out.fund=ESTAB_ROTULO[cod]+' — '+base;
  }
  return out;
}

/* Substituição tributária pelo anexo oficial da UF — não mais pelo CEST que o
   cliente digitou. O anexo cita NCM em 4, 6 ou 8 dígitos. */
function candidatosST(ncm){
  if(!ncm || !ST.length) return [];
  const achados = ST.filter(s=>ncm.startsWith(s.ncm));
  if(!achados.length) return [];
  const maisEspecifico = achados[0].ncm.length;
  return achados.filter(s=>s.ncm.length===maisEspecifico);
}

/* abreviações comuns no cadastro comercial que o anexo escreve por extenso */
const ABREV = {lt:'lata', lata:'lata', vd:'vidro', vidro:'vidro', pet:'pet', ks:'', cx:'caixa',
               gfa:'garrafa', gf:'garrafa', dsc:'descartavel', desc:'descartavel', retor:'retornavel'};
function termosDaDescricao(d){
  const brutos = norm(d).split(/[^a-z0-9]+/).filter(Boolean);
  const saida = new Set();
  brutos.forEach(t=>{ if(ABREV[t]) saida.add(ABREV[t]); if(t.length>=3) saida.add(t); });
  return [...saida].filter(Boolean);
}

/* Desempate entre CEST do mesmo NCM:
   1. descarta o candidato cuja cláusula "exceto ..." alcança o produto
      (ex.: "Água aromatizada, EXCETO os refrescos e refrigerantes" não serve
      para um refrigerante);
   2. pontua pelo número de palavras distintivas que casam com a descrição;
   3. só confirma quando há um vencedor isolado — senão manda para revisão. */
function consultarST(ncm, desc){
  const candidatos = candidatosST(ncm);
  if(!candidatos.length) return null;
  if(candidatos.length===1) return {...candidatos[0], confirmado:true, alternativas:1, candidatos};

  const termos = termosDaDescricao(desc);
  const casa = (palavra, t) => palavra===t || (t.length>=4 && palavra.startsWith(t.slice(0,5))) || (palavra.length>=4 && t.startsWith(palavra.slice(0,5)));
  const palavrasDe = txt => norm(txt).split(/[^a-z0-9]+/).filter(p=>p.length>=3);

  // 1. cláusula de exceção
  const viaveis = candidatos.filter(c=>{
    const m = norm(c.descricao).split(/\bexceto\b/);
    if(m.length<2) return true;
    const excecoes = palavrasDe(m.slice(1).join(' ')).filter(p=>!['cest','classificados','descritos','nos','dos'].includes(p) && !/^\d/.test(p));
    return !excecoes.some(p=>termos.some(t=>casa(p,t)));
  });
  const base = viaveis.length? viaveis : candidatos;

  // 2. pontuação pelas palavras que distinguem
  const conjuntos = base.map(c=>new Set(palavrasDe(c.descricao)));
  const comuns = [...(conjuntos[0]||[])].filter(p=>conjuntos.every(c=>c.has(p)));
  const notas = base.map((c,idx)=>{
    const distintas=[...conjuntos[idx]].filter(p=>!comuns.includes(p));
    return distintas.filter(p=>termos.some(t=>casa(p,t))).length;
  });
  const melhor = Math.max(...notas, 0);
  const vencedores = base.filter((c,idx)=>notas[idx]===melhor && melhor>0);

  if(vencedores.length===1)
    return {...vencedores[0], confirmado:true, alternativas:candidatos.length, candidatos};

  // sem vencedor: o próprio anexo traz um código residual ("Demais...", "Outros...")
  // que é onde cai o que não se encaixa nos específicos
  const residual = base.find(c=>/^(demais|outros|outras)\b/.test(norm(c.descricao)));
  return {...(residual || base[0]), confirmado:false, alternativas:candidatos.length,
          candidatos, motivo: residual? 'sem indicação de embalagem ou tipo na descrição — usei o código residual do anexo' : ''};
}

/* ============================ MOTOR DE PREENCHIMENTO ============================ */
/* Avalia as condições de descrição do anexo (ex.: 1905.90.90 só é cesta básica
   para o pão comum). Sem confirmação, o benefício NÃO é aplicado automaticamente. */
function avaliarCondicao(hit, desc){
  const d = norm(desc);
  if(hit.exclui && hit.exclui.length && d && hit.exclui.some(w=>d.includes(norm(w))))
    return {aplica:false, motivo:'Descrição contém termo excluído pelo anexo. '+(hit.condicao||'')};
  if(hit.exige && hit.exige.length){
    if(!d) return {aplica:false, motivo:'Condição do anexo não pôde ser verificada (sem descrição). '+(hit.condicao||'')};
    if(!hit.exige.some(w=>d.includes(norm(w))))
      return {aplica:false, motivo:'Descrição não confirma a condição do anexo. '+(hit.condicao||'')};
  }
  return {aplica:true, motivo:hit.condicao||''};
}

function classificarIbsCbs(ncm, desc){
  for(let len=Math.min(8,ncm.length); len>=3; len--){
    const hits = BASE.get(ncm.slice(0,len));
    if(!hits) continue;
    const regra = ncm.slice(0,len);
    // entre os enquadramentos do NCM, fica o primeiro cuja condição a descrição confirma
    const okList = hits.map(h=>({h, c:avaliarCondicao(h, desc)}));
    const confirmado = okList.find(x=>x.c.aplica && (x.h.exige||x.h.exclui));
    const escolhido = confirmado || okList.find(x=>x.c.aplica) || null;

    if(!escolhido){            // nenhum enquadramento confirmado: não aplica benefício
      const ov0 = OVERRIDES[regra+'|000001'];
      if(ov0){ const mo=META.get(ov0.valor)||{};
        return {ct:ov0.valor, cst:mo.cst||ov0.valor.slice(0,3), desc:mo.descricao||'', red:mo.reducao||'',
                conf:'memoria', regra, orig:'000001',
                nota:'Enquadramento corrigido pela equipe para este fundamento ('+(ov0.por||'').split('@')[0]+')'}; }
      const m=META.get('000001')||{};
      return {ct:'000001', cst:'000', desc:m.descricao||'Tributação integral', red:'0%', conf:'rev', regra, orig:'000001',
              nota:'Benefício NÃO aplicado — '+okList[0].c.motivo+' Enquadramento possível: '+hits.map(h=>h.cclasstrib).join(' / ')+'.'};
    }
    const ov = OVERRIDES[regra+'|'+escolhido.h.cclasstrib];
    if(ov){
      const mo=META.get(ov.valor)||{};
      return {ct:ov.valor, cst:mo.cst||ov.valor.slice(0,3), desc:mo.descricao||'', red:mo.reducao||'',
              conf:'memoria', regra, orig:escolhido.h.cclasstrib,
              nota:'Enquadramento corrigido pela equipe para este fundamento ('+(ov.por||'').split('@')[0]+')'};
    }
    const m=META.get(escolhido.h.cclasstrib)||{};
    const varios = hits.length>1;
    const condicional = !!(escolhido.h.exige||escolhido.h.exclui);
    return {ct:escolhido.h.cclasstrib, cst:escolhido.h.cst, desc:m.descricao||'', red:m.reducao||'',
            conf: (varios||condicional||len<6) ? 'rev' : 'ok', regra, orig:escolhido.h.cclasstrib,
            nota: varios ? 'NCM com mais de um enquadramento ('+hits.map(h=>h.cclasstrib).join(' / ')+') — confirmado pela descrição.'
                         : (condicional ? 'Condição confirmada pela descrição. '+(escolhido.h.condicao||'') : '')};
  }
  const m=META.get('000001')||{};
  return {ct:'000001', cst:'000', desc:m.descricao||'Tributação integral', red:'0%', conf:'ok', regra:'—'};
}

/* NCM genérico: mesmo código em muitos produtos distintos = cadastro suspeito */
function detectarNcmGenerico(itens){
  const porNcm=new Map();
  itens.forEach(i=>{ if(!porNcm.has(i.ncm)) porNcm.set(i.ncm,[]); porNcm.get(i.ncm).push(i); });
  porNcm.forEach((lista,ncm)=>{
    if(lista.length<8) return;
    lista.forEach(i=>{
      i.ncmGenerico = lista.length;
      i.nota = (i.nota?i.nota+' · ':'') + `NCM usado em ${lista.length} produtos diferentes desta planilha — provável NCM genérico; confira a classificação do item.`;
      if(i.status==='ok') i.status='rev';
    });
  });
}

/* Código residual (RGI 3-a): termina em 00 ou 90 havendo item específico na
   mesma subposição. É o sinal clássico de NCM "jogado" no cadastro. */
function ncmResidual(ncm){
  if(!/^(00|90)$/.test(ncm.slice(-2))) return false;
  const base = ncm.slice(0,6);
  for(const c of TIPI){
    if(c.length===8 && c.slice(0,6)===base && c!==ncm && !/^(00|90)$/.test(c.slice(-2))) return true;
  }
  return false;
}

function validarNcm(bruto){
  const d = dig(bruto);
  if(!d) return {ncm:'', status:'err', msg:'NCM ausente'};
  if(d.length===8){
    // só acusa NCM inexistente quando a TIPI está carregada por inteiro (>10 mil códigos);
    // com carga parcial a checagem acusaria falso positivo em tudo
    if(TIPI.size>8000 && !TIPI.has(d)) return {ncm:d, status:'err', msg:'NCM não consta na nomenclatura vigente — risco de Rejeição 778'};
    if(TIPI.size>8000 && ncmResidual(d))
      return {ncm:d, status:'rev', msg:'Código residual (termina em 00/90) havendo item específico na mesma subposição — pela RGI 3-a prevalece o mais específico'};
    return {ncm:d, status:'ok', msg:''};
  }
  if(d.length===7) return {ncm:'0'+d, status:'rev', msg:'NCM com 7 dígitos — provável zero à esquerda; corrigido para '+('0'+d)+', confirme'};
  return {ncm:d, status:'err', msg:'NCM com '+d.length+' dígitos — inválido'};
}

/* CSOSN/CST e CFOP conforme o regime do cliente e a presença de ST */
/* o código que já estava na planilha indica ST? depende do regime:
   Simples trabalha com CSOSN (201,202,203,500) e o regime normal com CST ICMS,
   que pode vir precedido do dígito de origem da mercadoria (060, 160, 260...) */
function indicaST(cstOrig, simples){
  const d = dig(cstOrig||''); if(!d) return false;
  if(simples) return ['201','202','203','500'].includes(d.padStart(3,'0'));
  const cst = d.length>=3 ? d.slice(-2) : d.padStart(2,'0');
  return ['10','30','60','70'].includes(cst);
}

function fiscalPorRegime(item, cliente){
  const simples = cliente && (cliente.regime==='simples' || cliente.opcao_simples);
  // o anexo oficial da UF é a autoridade; o CEST digitado na planilha é só pista
  // e vale apenas quando o anexo daquela UF ainda não foi carregado
  const temST = ST.length
    ? !!item.st
    : (!!item.cestOrig || indicaST(item.cstOrig, simples));
  const out = {};
  if(simples){
    out.cst   = temST ? '500' : '102';
    out.cfopS = temST ? '5405' : '5102';
    out.cfopE = temST ? '1403' : '1102';
    out.nota  = 'Simples Nacional: CSOSN '+out.cst+(temST?' (mercadoria com ST)':' (sem ST)')
              + (item.st? ' · '+item.st.fundamento : '');
  } else {
    out.cst   = temST ? '060' : (item.cstIcms || '000');
    out.cfopS = temST ? '5405' : '5102';
    out.cfopE = temST ? '1403' : '1102';
    out.nota  = 'Regime normal: CST '+out.cst+(temST?' (ST já recolhida)':'')
              + (item.st? ' · '+item.st.fundamento : '');
  }
  out.sugestao = true;   // depende da operação real — sempre marcado para revisão
  return out;
}

/* ============================ PASSO 1 · ARQUIVO ============================ */
$('drop').onclick=()=>$('file').click();
$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('over')};
$('drop').ondragleave=()=>$('drop').classList.remove('over');
$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('over'); if(e.dataTransfer.files[0]) lerArquivo(e.dataTransfer.files[0]);};
$('file').onchange=e=>{ if(e.target.files[0]) lerArquivo(e.target.files[0]); };

function lerArquivo(f){
  const rd=new FileReader();
  rd.onload=async ev=>{
    RAW=ev.target.result.slice(0); RAWNAME=f.name;
    WB=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
    // a aba de cadastro é a que tem o cabeçalho mais reconhecível, não necessariamente a primeira
    const notas = WB.SheetNames.map(n=>({n, ...acharCabecalho(lerAba(n))}));
    const melhor = notas.slice().sort((a,b)=>b.p-a.p)[0] || {n:WB.SheetNames[0]};
    $('selAba').innerHTML = WB.SheetNames.map(n=>`<option value="${esc(n)}" ${n===melhor.n?'selected':''}>${esc(n)}</option>`).join('');
    await escolherAba(melhor.n);
    $('p2').hidden=false; $('p2').open=true; $('p1').open=false;
    $('resumoArq').textContent = RAWNAME;
  };
  rd.readAsArrayBuffer(f);
}

/* lê a aba em coordenadas absolutas: índice 0 é sempre a linha 1 e a coluna A,
   não importa onde a planilha do cliente começa */
function lerAba(nome){
  const ws = WB && WB.Sheets[nome]; if(!ws || !ws['!ref']) return [];
  const r = XLSX.utils.decode_range(ws['!ref']); r.s.r=0; r.s.c=0;
  return XLSX.utils.sheet_to_json(ws,{header:1, defval:'', blankrows:true, range:r});
}
/* o cabeçalho é a linha que mais parece cabeçalho: nomes de campo fiscais conhecidos,
   texto, e nenhum código numérico longo (que indica linha de produto) */
const PISTAS = ['ncm','cest','cst','csosn','cfop','descricao','produto','mercadoria','codigo','cod','ean','gtin','barras',
                'unidade','und','un','aliquota','aliq','icms','ipi','pis','cofins','classtrib','cclasstrib','preco','valor','referencia','item','origem','mva'];
function pontuarLinha(r){
  let pistas=0, texto=0, numeros=0;
  (r||[]).forEach(c=>{
    const t = String(c).trim(); if(!t) return;
    if(/^\d{6,}$/.test(t.replace(/\./g,''))) numeros++;
    const n = norm(t); if(/[a-z]/.test(n)) texto++;
    const pal = n.split(/[^a-z0-9]+/).filter(Boolean);
    if(PISTAS.some(k=>pal.includes(k))) pistas++;
  });
  return pistas*10 + Math.min(texto,6) - numeros*4;
}
function acharCabecalho(aoa){
  let m = {i:0, p:-99};
  for(let i=0;i<Math.min(aoa.length,300);i++){ const p=pontuarLinha(aoa[i]); if(p>m.p) m={i,p}; }
  return m;
}
async function escolherAba(nome){
  SHEET = nome;
  const aoa = lerAba(SHEET);
  HR = acharCabecalho(aoa).i;
  const larg = Math.max(...aoa.slice(HR, HR+50).map(r=>r.length), 1);
  HEADERS = Array.from({length:larg}, (_,i)=>{ const h=String((aoa[HR]||[])[i]??'').trim(); return h; });
  await montarMapa();
  const ini = HEADERS.findIndex(h=>h); const col = XLSX.utils.encode_col(Math.max(ini,0));
  $('infoArq').textContent = `${aoa.length-HR-1} linhas · cabeçalho na linha ${HR+1}, a partir da coluna ${col} · aba "${SHEET}"`;
  $('mapOrigem').textContent = CLIENTE && MAPA.__salvo ? '— mapeamento salvo deste cliente' : '— detectado automaticamente';
}

const CAMPOS = [
  ['desc',  'Descrição do produto', ['descricao','descrição','produto','mercadoria','nome','item']],
  ['ncm',   'NCM',                  ['ncm','classificacao fiscal','classificação fiscal']],
  ['cest',  'CEST',                 ['cest']],
  ['red',   'Redução BC ICMS (%)',  ['reducao bc','redução bc','% reducao','% redução','red bc']],
  ['mva',   'MVA ST (%)',           ['mva']],
  ['valor', 'Valor de venda',       ['valor','preco','preço','venda']],
  ['cst',   'CST/CSOSN ICMS',       ['cst/csosn','csosn','cst icms','cst','situacao tributaria','situação tributária']],
  ['aliq',  'Alíquota ICMS',        ['aliquota icms','alíquota icms','aliq icms','% icms','icms %','aliquota','alíquota','aliq']],
  ['cfopS', 'CFOP saída',           ['cfop saida','cfop saída']],
  ['cfopE', 'CFOP entrada',         ['cfop entrada']],
  ['ctCbs', 'cClassTrib CBS',       ['classtrib cbs']],
  ['dsCbs', 'Descrição cClassTrib CBS', ['descricao classtrib cbs','descrição classtrib cbs']],
  ['cstCbs','CST CBS',              ['cst cbs']],
  ['ctIbs', 'cClassTrib IBS',       ['classtrib ibs']],
  ['dsIbs', 'Descrição cClassTrib IBS', ['descricao classtrib ibs','descrição classtrib ibs']],
  ['cstIbs','CST IBS',              ['cst ibs']],
  ['cstPis','CST PIS/COFINS saída',  ['cst pis/cofins','cst pis','cst saida pis','cst pis saida']],
  ['cstPisE','CST PIS/COFINS entrada',['cst pis entrada','cst entrada pis','cst pis/cofins entrada']],
  ['aliqPis','Alíquota PIS (%)',     ['aliquota pis','alíquota pis','aliq pis','% pis']],
  ['aliqCofins','Alíquota COFINS (%)',['aliquota cofins','alíquota cofins','aliq cofins','% cofins']],
  ['natRec','Natureza da receita',   ['natureza da receita','natureza receita','nat receita','nat. receita','cod natureza']],
  ['estAb', 'Estoque de abertura CBS (F150)', ['estoque de abertura','estoque abertura','desc_est']]
];

async function montarMapa(){
  MAPA={};
  if(CLIENTE){
    const {data} = await sb.from('clientes').select('observacoes').eq('id',CLIENTE.id).maybeSingle();
    try{ const salvo=JSON.parse((data&&data.observacoes)||'{}').mapa;
      if(salvo && salvo.__headers===HEADERS.join('|')){ MAPA={...salvo,__salvo:true}; }
    }catch(e){}
  }
  const nh=HEADERS.map(h=>norm(h||''));
  const NAO = {desc:['classtrib','cst','cfop','ncm','cest','cod'], cst:['ibs','cbs','pis','cofins','ipi'],
    valor:['icms','ipi'], aliq:['ipi','pis','cofins','ibs','cbs','mva','reduc','icms st','interestad','fcp'],
    cstPis:['entrada','ibs','cbs','icms'], cstPisE:['saida','ibs','cbs','icms']};
  CAMPOS.forEach(([k,,alvos])=>{
    if(MAPA[k]!==undefined) return;
    const pode = h=>h && !(NAO[k]||[]).some(x=>h.includes(x));
    let i=nh.findIndex(h=>pode(h) && alvos.some(a=>h===norm(a)));
    if(i<0) i=nh.findIndex(h=>pode(h) && alvos.some(a=>h.includes(norm(a))));
    MAPA[k]= i>=0? i : '';
  });
  $('mapGrid').innerHTML = CAMPOS.map(([k,rot])=>`
    <div><label class="f">${rot}</label>
      <select data-campo="${k}">
        <option value="">— não usar —</option>
        ${HEADERS.map((h,i)=>h?`<option value="${i}" ${String(MAPA[k])===String(i)?'selected':''}>${esc(h)} (${XLSX.utils.encode_col(i)})</option>`:'').join('')}
      </select></div>`).join('');
  $('mapGrid').querySelectorAll('select').forEach(s=>s.onchange=()=>{ MAPA[s.dataset.campo]= s.value===''?'':+s.value; });
}

$('selAba').onchange = e=>escolherAba(e.target.value);

$('btnSalvarMapa').onclick = async ()=>{
  if(!CLIENTE){ toast('Selecione o cliente antes de salvar o mapeamento.'); return; }
  const mapa={...MAPA, __headers:HEADERS.join('|')}; delete mapa.__salvo;
  const {error} = await sb.from('clientes').update({observacoes: JSON.stringify({mapa})}).eq('id',CLIENTE.id);
  toast(error? 'Falha ao salvar: '+error.message : 'Mapeamento salvo — da próxima planilha deste cliente ele já vem pronto.');
};

/* ============================ PASSO 2 · PREENCHER ============================ */
$('selCliente').onchange = async e=>{
  CLIENTE = CLIENTES.find(c=>c.id===e.target.value)||null;
  await Promise.all([carregarST(), carregarRegrasICMS()]);
  if(CLIENTE) toast(`Cliente ${esc(CLIENTE.uf)} · ${ST.length} linhas de substituição tributária (${ST_FONTE}) e ${REGRAS_ICMS.length} regras de alíquota, redução e isenção.`);
};

$('btnRodar').onclick = async ()=>{
  if(MAPA.ncm==='' || MAPA.ncm===undefined){ toast('Indique a coluna de NCM.'); return; }
  const aoa=lerAba(SHEET);
  ESCOPO = lerEscopo();
  ITENS=[];
  // sugestões de NCM pela descrição, em lote, antes de enquadrar (o NCM sugerido já entra no ICMS/IBS/PIS)
  let SUG = new Map();
  if(ESCOPO.ncm && MAPA.desc!=='' && MAPA.desc!==undefined){
    $('btnRodar').disabled = true; toast('Lendo as descrições para conferir os NCM…');
    try{ SUG = await sugestoesPorDescricao(aoa.slice(HR+1).map(r=>String(r[MAPA.desc]||'').trim())); }
    catch(e){ console.warn(e); }
    $('btnRodar').disabled = false;
  }
  // NCM do mesmo produto em outra linha: preenche quem veio em branco
  const ncmPorDesc = new Map();
  if(MAPA.desc!=='' && MAPA.desc!==undefined) aoa.slice(HR+1).forEach(r=>{
    const d=norm(String(r[MAPA.desc]||'')), n=dig(r[MAPA.ncm]);
    if(d && n.length===8 && (TIPI.size<8000 || TIPI.has(n))){ const c=ncmPorDesc.get(d)||new Map(); c.set(n,(c.get(n)||0)+1); ncmPorDesc.set(d,c); }
  });
  const cabecalhoTxt = (aoa[HR]||[]).map(c=>norm(String(c))).join('|');
  aoa.slice(HR+1).forEach((r,k)=>{
    const idx = HR+1+k;                                   // linha absoluta (0 = linha 1 do Excel)
    if(!r.some(c=>(c+'').trim()!=='')) return;
    if(r.map(c=>norm(String(c))).join('|')===cabecalhoTxt) return;   // cabeçalho repetido
    const descLinha = MAPA.desc!=='' ? String(r[MAPA.desc]||'').trim() : '';
    let bruto = r[MAPA.ncm];
    if((bruto+'').trim()==='' && !descLinha) return;
    let v = validarNcm(bruto);
    if(!dig(bruto) && descLinha && ESCOPO.ncm){
      const c = ncmPorDesc.get(norm(descLinha));
      if(c){ const n=[...c.entries()].sort((a,b)=>b[1]-a[1])[0][0];
        v = {ncm:n, status:'rev', msg:'NCM em branco — preenchido com o NCM do mesmo produto em outra linha da planilha'}; }
    } else if(v.status==='err' && v.ncm.length===8 && TIPI.size>8000){
      // NCM inexistente: só sugere quando a subposição tem um único código válido
      const irmaos=[...TIPI].filter(t=>t.length===8 && t.startsWith(v.ncm.slice(0,6)));
      if(irmaos.length===1) v = {ncm:irmaos[0], status:'rev', ncmTroca:v.ncm,
        msg:`NCM ${v.ncm} não existe na TIPI; a subposição ${v.ncm.slice(0,4)}.${v.ncm.slice(4,6)} tem um único código válido (${irmaos[0]}) — confirme`};
    }
    if(!ESCOPO.ncm){ v = {...v, ncm: dig(bruto).length===8 ? dig(bruto) : v.ncm}; }
    const pre = {ncm:v.ncm, ncmStatus:v.status, ncmMsg:v.msg, ncmOrig:(bruto+'').trim()};
    if(v.status!=='rev' || !v.ncmTroca) avaliarDescricaoNcm(pre, SUG.get(descLinha));
    v = {...v, ncm:pre.ncm, status:pre.ncmStatus, msg:pre.ncmMsg};
    const item = {
      i:idx,
      desc: descLinha,
      ncmOrig: (bruto+'').trim(),
      ncm: v.ncm, ncmStatus: v.status, ncmMsg: v.msg,
      ncmSugs: pre.ncmSugs, ncmIncoerente: pre.ncmIncoerente, ncmPorDescricao: pre.ncmPorDescricao,
      cestOrig: MAPA.cest!=='' ? (r[MAPA.cest]+'').trim() : '',
      cstOrig:  MAPA.cst!==''  ? (r[MAPA.cst]+'').trim()  : '',
      ctOrig:   MAPA.ctIbs!==''&&MAPA.ctIbs!==undefined ? (r[MAPA.ctIbs]+'').trim()
              : (MAPA.ctCbs!==''&&MAPA.ctCbs!==undefined ? (r[MAPA.ctCbs]+'').trim() : ''),
      cfopSOrig:MAPA.cfopS!==''? (r[MAPA.cfopS]+'').trim(): '',
      valor: MAPA.valor!=='' && MAPA.valor!==undefined
             ? parseFloat((r[MAPA.valor]+'').replace(/\./g,'').replace(',','.'))||0 : 0
    };
    item.st = consultarST(item.ncm, item.desc);
    if(item.st){
      item.cest = item.st.cest;
      if(item.cestOrig && dig(item.cestOrig)!==item.st.cest){
        item.cestDivergente = true;
        item.nota = (item.nota?item.nota+' · ':'') + `CEST da planilha (${dig(item.cestOrig)}) difere do anexo da UF (${item.st.cest})`;
      }
      if(!item.st.confirmado){
        item.nota = (item.nota?item.nota+' · ':'') + `NCM com ${item.st.alternativas} CEST possíveis no anexo — confirme pela descrição`;
      }
    } else {
      // sem ST na UF: o CEST continua obrigatório na NF-e se o item constar dos Anexos II a XXVI
      // do Conv. ICMS 142/2018 (cláusula vigésima, I) — tabela de apoio, por isso fica a conferir
      const cn = cestNacionalDoItem(item.ncm, item.desc), co = dig(item.cestOrig);
      const add = t => { item.nota = (item.nota?item.nota+' · ':'') + t; };
      const CL = 'obrigatório na NF-e mesmo sem ST (Conv. ICMS 142/2018, cl. vigésima, I)';
      if(co){
        if(cn.todos.some(c=>c.cest===co)){ item.cest = co; item.cestNacional = true;
          add(`CEST ${fmtCest(co)} mantido: o NCM não tem ST no RN, mas o CEST é ${CL}`); }
        else { item.cestDivergente = true;
          add(CEST_NAC.has(co) ? `CEST ${fmtCest(co)} existe no Conv. 142/2018, mas não é associado a este NCM na tabela de apoio — confira`
               : CEST_NAC.size ? `CEST ${fmtCest(co)} não consta da tabela do Conv. ICMS 142/2018 nem do anexo de ST da UF`
               : 'Planilha traz CEST, mas o NCM não consta no anexo de ST da UF'); }
      } else if(cn.casam.length===1){
        const c = cn.casam[0]; item.cest = c.cest; item.cestNacional = true; item.cestSugNac = true;
        add(`CEST ${fmtCest(c.cest)} sugerido pelo Conv. ICMS 142/2018 (${String(c.descricao).slice(0,70)}) — sem ST no RN, mas ${CL}. Confira`);
      } else if(cn.casam.length>1){
        item.cestSugNac = true;
        add(`NCM consta do Conv. ICMS 142/2018 com ${cn.casam.length} CEST possíveis (${cn.casam.slice(0,4).map(c=>fmtCest(c.cest)).join(', ')}) — o CEST é ${CL}; escolha pela descrição`);
      }
    }
    const a = classificarIbsCbs(item.ncm, item.desc);
    item.ct=a.ct; item.cstTrib=a.cst; item.ctDesc=a.desc; item.red=a.red; item.regra=a.regra;
    item.origCt=a.orig||a.ct;
    item.nota=[item.nota, a.nota].filter(Boolean).join(' · '); item.confIbs=a.conf;
    const ic = icmsDoItem(item, CLIENTE);
    item.aliq=ic.aliq; item.redBc=ic.red; item.fundIcms=ic.fund; item.especieIcms=ic.especie; item.cstIcms=ic.cst;
    item.aliqOrig = MAPA.aliq!=='' && MAPA.aliq!==undefined ? (r[MAPA.aliq]+'').trim() : '';
    item.mva = item.st ? mvaDoCest(item.cest) : '';
    const f = fiscalPorRegime(item, CLIENTE);
    if(item.st && !ehIndustria(CLIENTE)){
      // comércio com ST: o ICMS foi retido antes; não há destaque de alíquota no cadastro
      item.aliq=''; item.redBc='';
      item.fundIcms='Substituição tributária: ICMS retido anteriormente, sem destaque na saída — '+(item.st.fundamento||'Anexo 007 do RICMS/RN');
    }
    const cstCalc = comOrigem(f.cst, item.cstOrig, CLIENTE);
    item.cst = (ESCOPO.modo==='corrigir' && ESCOPO.icms) ? cstCalc : (item.cstOrig || cstCalc);
    item.cstSug = !item.cstOrig;
    item.cfopS = item.cfopSOrig || f.cfopS; item.cfopSSug = !item.cfopSOrig;
    item.cfopE = f.cfopE; item.cfopESug = true;   // vazio em toda a planilha: sempre sugestão
    item.cfopErro = conferirCfop(item.cfopSOrig, 'saida');
    if(item.cfopErro) item.nota = (item.nota?item.nota+' · ':'') + item.cfopErro;
    item.notaFiscal = f.nota;
    const pc = pisCofinsDoItem(item, CLIENTE);
    item.cstPis=pc.cst; item.cstPisE=pc.cstE; item.aliqPis=pc.aliqPis; item.aliqCofins=pc.aliqCofins;
    item.natRec=pc.nat; item.tribPc=pc.trib; item.fundPc=pc.fund; item.revPc=pc.rev;
    const ea = estoqueAbertura(item, CLIENTE, pc);
    item.estAb=ea.cod; item.fundEstAb=ea.fund; item.revEstAb=ea.rev;
    if(ESCOPO.pis && (pc.rev || ea.rev)) item.nota=[item.nota, pc.rev, ea.rev].filter(Boolean).join(' · ');
    const orig = k => MAPA[k]!=='' && MAPA[k]!==undefined ? (r[MAPA[k]]+'').trim() : '';
    item.cstPisOrig=orig('cstPis'); item.cstPisEOrig=orig('cstPisE'); item.aliqPisOrig=orig('aliqPis');
    item.aliqCofinsOrig=orig('aliqCofins'); item.natRecOrig=orig('natRec'); item.estAbOrig=orig('estAb');
    if(ESCOPO.modo==='vazios' || !ESCOPO.pis){ if(item.cstPisOrig) item.cstPis=item.cstPisOrig; }
    if(dig(item.ncm).length!==8){
      // sem NCM válido não há base para enquadrar: nada é preenchido, o item vai para conferência
      Object.assign(item,{aliq:'',redBc:'',mva:'',cest:'',ct:'',cstTrib:'',ctDesc:'',cfopS:item.cfopSOrig,cfopE:'',
        cstPis:item.cstPisOrig||'',cstPisE:'',aliqPis:'',aliqCofins:'',natRec:'',tribPc:'',fundPc:'',revPc:'',estAb:'',fundEstAb:'',revEstAb:'',
        cst:item.cstOrig, fundIcms:'', ncmStatus:'err'});
      item.nota=[item.nota,'Sem NCM válido: ICMS, CFOP e IBS/CBS não foram preenchidos'].filter(Boolean).join(' · ');
    }
    item.status = item.ncmStatus==='err' ? 'err'
                : (item.confIbs==='rev' || item.ncmStatus==='rev' || (ESCOPO.pis && (item.revPc || item.revEstAb))
                   || item.cestDivergente || item.cestSugNac || item.cfopErro || (item.st && !item.st.confirmado)) ? 'rev' : 'ok';
    ITENS.push(item);
  });
  detectarNcmGenerico(ITENS);
  marcarPrioridade(ITENS);
  carregarTextosOficiais().then(aplicarMemoria).then(consultarMemoriaNcm).then(()=>{ $('p3').hidden=false; FILTRO='all'; kpis(); tabela();
    $('p3').scrollIntoView({behavior:'smooth'});
    toast(`<b>${ITENS.length}</b> itens processados. ${ITENS.filter(i=>i.status!=='ok').length} precisam de conferência.`); });
};

/* Prioridade: a auditoria de NCM recomenda atacar primeiro o que tem maior
   impacto financeiro. Marca o terço superior por valor entre os itens que
   precisam de conferência. */
function marcarPrioridade(itens){
  const comValor = itens.filter(i=>i.valor>0).map(i=>i.valor).sort((a,b)=>b-a);
  if(comValor.length<6) return;
  const corte = comValor[Math.floor(comValor.length*0.2)];
  itens.forEach(i=>{ i.prioritario = i.valor>0 && i.valor>=corte; });
}

/* Traz o texto oficial da nomenclatura para cada NCM da planilha. É com ele
   que a pessoa compara a descrição do produto — o método que a própria
   auditoria de NCM recomenda. */
async function carregarTextosOficiais(){
  const codigos=[...new Set(ITENS.map(i=>i.ncm).filter(n=>n && n.length===8))];
  for(let i=0;i<codigos.length;i+=400){
    const {data} = await sb.from('tipi').select('ncm,descricao,descricao_completa,aliquota_ipi')
                           .in('ncm', codigos.slice(i,i+400));
    (data||[]).forEach(r=>{
      ITENS.filter(it=>it.ncm===r.ncm).forEach(it=>{
        it.ncmTexto = r.descricao_completa || r.descricao || '';
        it.ncmItem  = r.descricao || '';
        it.ipi      = r.aliquota_ipi || '';
      });
    });
  }
}

/* A equipe já decidiu este produto antes? Procura por descrição parecida em
   qualquer cliente. É a correlação que melhora com o uso. */
async function consultarMemoriaNcm(){
  const alvos = ITENS.filter(i=>i.status!=='ok' && i.desc).slice(0,120);
  for(const it of alvos){
    const {data} = await sb.rpc('sugerir_por_memoria', {p_descricao:it.desc, p_campo:'ncm', p_limite:1});
    const m = (data||[])[0];
    if(m && m.valor && m.valor!==it.ncm){
      it.memNcm = {valor:m.valor, por:(m.usuario||'').split('@')[0], quando:m.quando,
                   semelhanca:Math.round((m.semelhanca||0)*100)};
    }
  }
}

/* Busca assistida na nomenclatura: devolve candidatos, nunca aplica sozinho. */
async function buscarNcm(termo){
  const {data, error} = await sb.rpc('sugerir_ncm', {p_descricao:termo, p_limite:8});
  if(error){ toast('Busca indisponível: '+error.message); return []; }
  return data||[];
}
async function aplicarMemoria(){
  if(!ITENS.length) return;
  const data = await carregarTodos('memoria_correcao','*', q=>q.eq('cliente_id', CLIENTE? CLIENTE.id : null).order('id'));
  const mem=new Map(); (data||[]).forEach(m=>mem.set(`${m.ncm}|${m.descricao_norm}|${m.campo}`, m));
  ITENS.forEach(it=>{
    ['cclasstrib','cst','cfop_saida','cfop_entrada','ncm'].forEach(campo=>{
      const m = mem.get(`${it.ncm}|${norm(it.desc)}|${campo}`); if(!m) return;
      if(campo==='cclasstrib'){ it.ct=m.valor; const md=META.get(m.valor)||{}; it.ctDesc=md.descricao||''; it.cstTrib=md.cst||it.cstTrib; }
      if(campo==='cst'){ it.cst=m.valor; it.cstSug=false; }
      if(campo==='cfop_saida'){ it.cfopS=m.valor; it.cfopSSug=false; }
      if(campo==='cfop_entrada'){ it.cfopE=m.valor; it.cfopESug=false; }
      if(campo==='ncm'){ it.ncm=m.valor; it.ncmStatus='ok'; it.ncmMsg=''; }
      it.status='mem'; it.porMemoria=(m.usuario||'equipe');
      it.memoriaGravada={por:(m.usuario||'equipe'), quando:(m.criado_em||'').slice(0,10), campo};
    });
  });
}

const SIT = {ok:['c-ok','Conferido'], rev:['c-rev','Revisar'], err:['c-err','NCM inválido'], mem:['c-mem','Memória']};
function kpis(){
  const c={all:ITENS.length, ok:0, rev:0, err:0, mem:0};
  ITENS.forEach(i=>c[i.status]++);
  $('kpis').innerHTML = [['all','k-all','Total'],['ok','k-ok','Preenchido'],['rev','k-rev','Revisar'],
    ['err','k-err','NCM inválido'],['mem','k-mem','Memória']]
    .map(([k,cl,l])=>`<button class="kpi ${cl} ${FILTRO===k?'sel':''}" data-f="${k}"><div class="v">${c[k]}</div><div class="l">${l}</div></button>`).join('');
  $('kpis').querySelectorAll('.kpi').forEach(b=>b.onclick=()=>{FILTRO=b.dataset.f;kpis();tabela();});
}
$('busca').oninput=()=>tabela();

function chaveItem(it){ return it.sheet? it.sheet+'||'+it.i : String(it.i); }

function tabela(){
  const q=norm($('busca').value);
  const linhas=ITENS.filter(i=>(FILTRO==='all'||i.status===FILTRO) &&
    (!q || norm(i.desc).includes(q) || i.ncm.includes(q) || (i.cest||'').includes(q)));
  const gravados = ITENS.filter(i=>i.memoriaGravada).length;
  $('infoFiltro').innerHTML = `${linhas.length} de ${ITENS.length} itens`
    + (gravados? ` · <b class="gravado-inline">${gravados} gravados na memória</b>` : '');
  $('tbody').innerHTML = linhas.slice(0,400).map(it=>{
    const [cl,rot]=SIT[it.status];
    const k=chaveItem(it);
    const msg=[it.ncmMsg,it.nota,it.notaFiscal].filter(Boolean).join(' · ');
    return `<tr class="${SELECAO.has(k)?'sel':''}">
      <td class="cbcol"><input type="checkbox" data-k="${esc(k)}" ${SELECAO.has(k)?'checked':''}></td>
      <td>
        ${it.prioritario?'<span class="chip c-rev">alto valor</span> ':''}
        <button class="linkitem" data-abre="${esc(k)}">${esc(it.desc)||'(sem descrição)'}</button>
        ${msg?`<div class="muted">${esc(msg)}</div>`:''}
        ${it.memNcm?`<div class="muted memncm">A equipe já usou <b>${esc(it.memNcm.valor)}</b> em produto parecido (${it.memNcm.semelhanca}%)</div>`:''}
      </td>
      <td class="mono ${it.ncm!==dig(it.ncmOrig)?'fill':''}">${it.ncm||esc(it.ncmOrig)}
        ${it.ncmItem?`<div class="muted oficial">${esc(it.ncmItem.replace(/<[^>]+>/g,'').slice(0,46))}</div>`:''}</td>
      <td class="mono ${it.cest&&it.cest!==dig(it.cestOrig)?'fill':''}">
        ${it.cest? esc(it.cest) : '<span class="muted">sem ST</span>'}
        ${it.st&&it.st.alternativas>1?`<div class="muted">${it.st.alternativas} CEST possíveis</div>`:''}</td>
      <td class="mono ${it.cstSug?'fill':''}">${esc(it.cst)}
        ${it.aliq!==undefined && it.aliq!=='' ? `<div class="muted" title="${esc(it.fundIcms||'')}">${esc(it.aliq)}%${it.redBc?' · red. '+esc(it.redBc)+'%':''}${it.mva?' · MVA '+esc(it.mva)+'%':''}</div>`:''}</td>
      <td class="mono ${it.cfopSSug?'fill':''}">${esc(it.cfopS)} · ${esc(it.cfopE)}</td>
      <td class="mono fill">${esc(it.ct)}
        <div class="muted ctdesc">${esc(it.ctDesc||'')}</div></td>
      <td><span class="chip ${cl}">${rot}</span>
        ${it.memoriaGravada?`<div class="gravado" title="gravado na memória da equipe por ${esc(it.memoriaGravada.por||'')} em ${esc(it.memoriaGravada.quando||'')}">✔ na memória<br><span class="gravado-quem">${esc((it.memoriaGravada.por||'').split('@')[0])}</span></div>`
          : it.porMemoria?`<div class="muted">${esc((it.porMemoria||'').split('@')[0])}</div>`:''}</td>
    </tr>`;
  }).join('');
  if(linhas.length>400) $('tbody').innerHTML += `<tr><td colspan="8" class="muted">Mostrando 400 itens do filtro — use a busca para chegar nos demais. A exportação inclui todos.</td></tr>`;
  $('tbody').querySelectorAll('button[data-abre]').forEach(b=>b.onclick=()=>abrirPainel(b.dataset.abre));
  $('tbody').querySelectorAll('input[type=checkbox]').forEach(c=>c.onchange=e=>{
    e.target.checked ? SELECAO.add(c.dataset.k) : SELECAO.delete(c.dataset.k);
    atualizarSelecao(); e.target.closest('tr').classList.toggle('sel', e.target.checked);
  });
}

function atualizarSelecao(){
  $('qtdSel').textContent=SELECAO.size;
  $('barraSel').hidden = SELECAO.size===0;
}
$('selTodos').onchange=e=>{
  const q=norm($('busca').value);
  const visiveis=ITENS.filter(i=>(FILTRO==='all'||i.status===FILTRO) &&
    (!q || norm(i.desc).includes(q) || i.ncm.includes(q) || (i.cest||'').includes(q)));
  if(e.target.checked) visiveis.forEach(i=>SELECAO.add(chaveItem(i)));
  else visiveis.forEach(i=>SELECAO.delete(chaveItem(i)));
  atualizarSelecao(); tabela();
};
$('btnLimparSel').onclick=()=>{ SELECAO.clear(); $('selTodos').checked=false; atualizarSelecao(); tabela(); };

/* ---------- aplicação em lote ---------- */
const CAMPO_ITEM = {cclasstrib:'ct', cest:'cest', cst:'cst', cfop_saida:'cfopS', cfop_entrada:'cfopE', ncm:'ncm'};
/* ---------- lote em duas etapas: planejar (sem efeito) → prévia → executar ---------- */
const ROTULO_LOTE = {cclasstrib:'cClassTrib', cest:'CEST', cst:'CST/CSOSN ICMS', cfop_saida:'CFOP saída', cfop_entrada:'CFOP entrada', ncm:'NCM'};
function planejarLote(campo, valor, chavesIn, replicarFundamento){
  const chaves = new Set(chavesIn), pedidas = new Set(chavesIn);
  let alvos = ITENS.filter(i=>chaves.has(chaveItem(i)));
  const fundamentos = new Map(); let extras = [];
  if(alvos.length && valor && campo==='cclasstrib' && replicarFundamento!==false){
    alvos.forEach(it=>{ if(it.regra && it.regra!=='—' && it.origCt)
      fundamentos.set(it.regra+'|'+it.origCt, {regra:it.regra, origem:it.origCt}); });
    extras = ITENS.filter(it=>!chaves.has(chaveItem(it)) && it.regra && it.origCt
                              && fundamentos.has(it.regra+'|'+it.origCt));
    extras.forEach(it=>chaves.add(chaveItem(it)));
    alvos = ITENS.filter(i=>chaves.has(chaveItem(i)));
  }
  const prop = campo==='ncm' ? 'ncm' : CAMPO_ITEM[campo];
  const mudam = alvos.filter(it=>String(it[prop]||'')!==String(valor));
  return {campo, valor, prop, alvos, mudam, pedidas, fundamentos, replicados:extras.filter(e=>mudam.includes(e)).length};
}

/* janela de confirmação: mostra o que muda antes de qualquer gravação */
function previa(planos){
  const uteis = planos.filter(p=>p && p.mudam.length);
  if(!uteis.length) return Promise.resolve(false);
  const itens = new Set(); uteis.forEach(p=>p.mudam.forEach(i=>itens.add(chaveItem(i))));
  $('pvTitulo').textContent = `Aplicar em ${itens.size} ${itens.size===1?'item':'itens'}?`;
  $('pvResumo').innerHTML = uteis.map(p=>`<b>${esc(ROTULO_LOTE[p.campo]||p.campo)}</b> → ${esc(p.valor)}: ${p.mudam.length} ${p.mudam.length===1?'item':'itens'}`
      + (p.replicados? ` <span class="gravado-inline">(${p.replicados} pela mesma regra de fundamento)</span>`:'')).join('<br>');
  const linhas=[];
  uteis.forEach(p=>p.mudam.slice(0,8).forEach(it=>linhas.push(`<tr><td>${esc((it.desc||'').slice(0,46))}</td>
      <td>${esc(ROTULO_LOTE[p.campo]||p.campo)}</td><td class="mono">${esc(it[p.prop]||'—')}</td><td class="mono"><b>${esc(p.valor)}</b></td></tr>`)));
  $('pvLinhas').innerHTML = linhas.slice(0,12).join('');
  const resto = uteis.reduce((a,p)=>a+p.mudam.length,0) - Math.min(12,linhas.length);
  $('pvMais').textContent = resto>0 ? `e mais ${resto} alteração(ões) do mesmo tipo.` : '';
  $('pvMemoria').hidden = false;
  const rep = uteis.reduce((a,p)=>a+(p.replicados||0),0);
  $('pvReplicarBox').hidden = !rep; $('pvReplicarN').textContent = rep===1 ? 'o outro item' : 'os outros '+rep+' itens'; $('pvReplicar').checked = true;
  $('previa').hidden = false; $('pvConfirmar').focus();
  return new Promise(res=>{
    const fim = ok=>{ $('previa').hidden=true; $('pvConfirmar').onclick=$('pvCancelar').onclick=null; document.removeEventListener('keydown',tecla);
                      res(ok && rep && !$('pvReplicar').checked ? 'sem-replicar' : ok); };
    const tecla = e=>{ if(e.key==='Escape') fim(false); };
    $('pvConfirmar').onclick=()=>fim(true); $('pvCancelar').onclick=()=>fim(false);
    document.addEventListener('keydown',tecla);
  });
}

async function executarLote(pl){
  const {campo, valor, prop, mudam:alvos, pedidas, fundamentos} = pl;
  if(!alvos.length) return 0;
  for(const [chave,f] of fundamentos){
    OVERRIDES[chave]={valor, por:USER, quando:new Date().toISOString()};
    await sb.from('fundamento_override').upsert([{campo:'cclasstrib', regra:f.regra,
      valor_origem:f.origem, valor_novo:valor, usuario:USER}], {onConflict:'campo,regra,valor_origem'});
  }
  const registros=[];
  alvos.forEach(it=>{
    it[prop]=valor;
    if(campo==='cclasstrib'){ const m=META.get(valor)||{}; it.cstTrib=m.cst||it.cstTrib; it.ctDesc=m.descricao||''; it.red=m.reducao||''; }
    if(campo==='cst') it.cstSug=false;
    if(campo==='cfop_saida') it.cfopSSug=false;
    if(campo==='cfop_entrada') it.cfopESug=false;
    if(campo==='cest'){ it.cestDivergente=false; it.mva=mvaDoCest(valor); }
    it.status='mem'; it.porMemoria=USER; it.edited=true;
    TRILHA.push({chave:chaveItem(it), campo:(campo==='cfop_saida'?'cfopS':campo==='cfop_entrada'?'cfopE':campo), valor, por:USER,
                 quando:new Date().toISOString().slice(0,16).replace('T',' '),
                 fundamento: it.regra||'', replicado: !pedidas.has(chaveItem(it))});
    registros.push({cliente_id: CLIENTE? CLIENTE.id : null, ncm:it.ncm, descricao_norm:norm(it.desc),
                    campo, valor, usuario:USER, origem:'manual'});
  });
  const {error} = await sb.from('memoria_correcao').upsert(registros, {onConflict:'cliente_id,ncm,descricao_norm,campo'});
  if(error){ toast('Aplicado na tela, mas não gravou na memória: '+error.message); }
  else { alvos.forEach(it=>{ it.memoriaGravada = {por:USER, quando:new Date().toISOString().slice(0,10), campo}; }); }
  ULTIMO_LOTE = {replicados:pl.replicados, total:alvos.length};
  return alvos.length;
}

/* compatibilidade: aplica com prévia */
async function aplicarEmLote(campo, valor, chaves, replicarFundamento){
  let pl = planejarLote(campo, valor, chaves, replicarFundamento);
  if(!pl.mudam.length) return 0;
  const r = await previa([pl]); if(!r) return 0;
  if(r==='sem-replicar') pl = planejarLote(campo, valor, chaves, false);
  const n = await executarLote(pl); kpis(); tabela(); carregarMemoria(); return n;
}
$('btnLote').onclick=async()=>{
  const campo=$('loteCampo').value, valor=$('loteValor').value.trim();
  if(!valor){ toast('Informe o valor a aplicar.'); return; }
  const n=await aplicarEmLote(campo, valor, new Set(SELECAO));
  if(!n){ toast('Nenhuma alteração aplicada.'); return; }
  $('loteValor').value='';
  const extra = ULTIMO_LOTE.replicados ? ` — incluindo <b>${ULTIMO_LOTE.replicados}</b> por regra de fundamento` : '';
  toast(`<b>${n}</b> itens atualizados e gravados na memória da equipe${extra}.`);
};

/* ---------- painel de revisão do item ---------- */
let ITEM_PAINEL=null, ESCOLHA={ncm:null, cest:null};
function fecharPainel(){ $('painel').hidden=true; ITEM_PAINEL=null; }
$('pnFechar').onclick=fecharPainel; $('painelFundo').onclick=fecharPainel;
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && !$('painel').hidden) fecharPainel(); });

function abrirPainel(chave){
  const it=ITENS.find(x=>chaveItem(x)===chave); if(!it) return;
  ITEM_PAINEL=it; ESCOLHA={ncm:null, cest:null};
  $('pnProduto').textContent=it.desc||'(sem descrição)';
  $('pnLinha').textContent=`linha ${it.i+1}${it.sheet?' · aba '+it.sheet:''}${it.valor?' · valor '+it.valor.toFixed(2):''}`;
  $('pnNcm').textContent=it.ncm||'—';
  $('pnNcmTexto').textContent=(it.ncmTexto||'').replace(/<[^>]+>/g,'').slice(0,180);
  $('pnBuscaNcm').value=it.desc||'';
  $('pnOpcoesNcm').innerHTML='';
  // CEST: todas as opções do anexo para este NCM
  const cands = candidatosST(it.ncm);
  $('pnSecaoSt').hidden = false;
  $('pnStFonte').textContent = cands.length? (cands[0].fundamento||'') : '';
  $('pnOpcoesSt').innerHTML = cands.length ? cands.map(c=>`
      <button class="opcao ${c.cest===it.cest?'escolhida':''}" data-cest="${esc(c.cest)}">
        <span class="cod">${esc(c.cest)}</span>
        <span class="txt">${esc(c.descricao)}</span></button>`).join('')
    : '<div class="muted">Este NCM não consta no anexo de substituição tributária da UF.</div>';
  $('pnOpcoesSt').querySelectorAll('button[data-cest]').forEach(b=>b.onclick=()=>{
    ESCOLHA.cest=b.dataset.cest;
    $('pnOpcoesSt').querySelectorAll('.opcao').forEach(o=>o.classList.remove('escolhida'));
    b.classList.add('escolhida');
  });
  // cClassTrib
  $('pnCt').innerHTML=[...META.entries()].map(([k,m])=>
    `<option value="${k}" ${k===it.ct?'selected':''}>${k} · ${esc((m.descricao||'').slice(0,46))}</option>`).join('');
  $('pnCtNota').textContent=it.nota||'';
  $('pnCst').value=it.cst||''; $('pnCfopS').value=it.cfopS||''; $('pnCfopE').value=it.cfopE||'';
  $('pnEscopo').value = SELECAO.size? 'selecao' : 'produto';
  $('painel').hidden=false;
}

$('pnBuscarNcm').onclick=async()=>{
  const termo=$('pnBuscaNcm').value.trim(); if(!termo) return;
  $('pnOpcoesNcm').innerHTML='<div class="muted">buscando…</div>';
  const cands=await buscarNcm(termo);
  $('pnOpcoesNcm').innerHTML = cands.length ? cands.map(c=>`
      <button class="opcao" data-ncm="${esc(c.ncm)}">
        <span class="cod">${esc(c.ncm)}${c.residual?' ⚠':''}</span>
        <span class="txt"><b>${esc((c.descricao_item||'').replace(/<[^>]+>/g,'').slice(0,60))}</b><br>
          ${esc((c.descricao||'').replace(/<[^>]+>/g,'').slice(0,130))}</span></button>`).join('')
    : '<div class="muted">Nenhum código encontrado. A busca é por texto da nomenclatura e não substitui as regras de classificação.</div>';
  $('pnOpcoesNcm').querySelectorAll('button[data-ncm]').forEach(b=>b.onclick=()=>{
    ESCOLHA.ncm=b.dataset.ncm;
    $('pnOpcoesNcm').querySelectorAll('.opcao').forEach(o=>o.classList.remove('escolhida'));
    b.classList.add('escolhida');
  });
};
$('pnBuscaNcm').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('pnBuscarNcm').click(); }});

$('pnAplicar').onclick=async()=>{
  const it=ITEM_PAINEL; if(!it) return;
  const escopo=$('pnEscopo').value;
  let chaves=new Set();
  if(escopo==='item') chaves.add(chaveItem(it));
  else if(escopo==='produto') ITENS.filter(x=>x.ncm===it.ncm && norm(x.desc)===norm(it.desc)).forEach(x=>chaves.add(chaveItem(x)));
  else if(escopo==='ncm') ITENS.filter(x=>x.ncm===it.ncm).forEach(x=>chaves.add(chaveItem(x)));
  else chaves=new Set(SELECAO.size? SELECAO : [chaveItem(it)]);

  const planos=[];
  if(ESCOLHA.ncm && ESCOLHA.ncm!==it.ncm) planos.push(planejarLote('ncm', ESCOLHA.ncm, chaves, false));
  if(ESCOLHA.cest) planos.push(planejarLote('cest', ESCOLHA.cest, chaves));
  if($('pnCt').value!==it.ct) planos.push(planejarLote('cclasstrib', $('pnCt').value, chaves));
  if($('pnCst').value!==it.cst) planos.push(planejarLote('cst', $('pnCst').value.trim(), chaves));
  if($('pnCfopS').value!==it.cfopS) planos.push(planejarLote('cfop_saida', $('pnCfopS').value.trim(), chaves));
  if($('pnCfopE').value!==it.cfopE) planos.push(planejarLote('cfop_entrada', $('pnCfopE').value.trim(), chaves));
  if(!planos.some(p=>p.mudam.length)){ toast('Nada foi alterado.'); return; }
  const r = await previa(planos); if(!r) return;
  if(r==='sem-replicar') for(let k=0;k<planos.length;k++)
    if(planos[k].campo==='cclasstrib') planos[k]=planejarLote('cclasstrib', planos[k].valor, chaves, false);
  let total=0;
  for(const pl of planos){
    if(pl.campo==='ncm'){
      const alvos=pl.mudam;
      alvos.forEach(x=>{ x.ncm=ESCOLHA.ncm; x.ncmStatus='mem'; x.ncmMsg='NCM definido no painel de revisão';
        x.st=consultarST(x.ncm,x.desc); x.cest=x.st?x.st.cest:''; x.mva=mvaDoCest(x.cest);
        const ic=icmsDoItem(x,CLIENTE); x.aliq=ic.aliq; x.redBc=ic.red; x.fundIcms=ic.fund;
        x.status='mem'; x.porMemoria=USER;
        TRILHA.push({chave:chaveItem(x), campo:'ncm', valor:ESCOLHA.ncm, por:USER, quando:new Date().toISOString().slice(0,16).replace('T',' '), fundamento:'', replicado:false}); });
      await sb.from('memoria_correcao').upsert(alvos.map(x=>({cliente_id:CLIENTE?CLIENTE.id:null, ncm:x.ncm,
        descricao_norm:norm(x.desc), campo:'ncm', valor:ESCOLHA.ncm, usuario:USER, origem:'manual'})),
        {onConflict:'cliente_id,ncm,descricao_norm,campo'});
      await carregarTextosOficiais(); total=Math.max(total, alvos.length);
    } else total=Math.max(total, await executarLote(pl));
  }
  carregarMemoria();
  fecharPainel(); kpis(); tabela();
  toast(total? `<b>${total}</b> item(ns) atualizado(s) e gravados na memória.` : 'Nada foi alterado.');
};

/* correção manual + replicação (mesmo NCM + mesma descrição, e mesma regra de enquadramento) */
/* ============================ EXPORTAÇÃO (preserva formatação) ============================ */
const colL = n => { let s=''; n++; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-1-m)/26; } return s; };
const colI = ref => { let n=0; for(const ch of ref.replace(/\d+/g,'')) n=n*26+(ch.charCodeAt(0)-64); return n-1; };

function colunaTemFormula(col){
  const ws = WB.Sheets[SHEET]; let n=0;
  for(const it of ITENS){ const c = ws[XLSX.utils.encode_cell({r:it.i, c:col})]; if(c && c.f) return true; if(++n>400) break; }
  return false;
}
function destinos(){
  // grava nas colunas que o cliente já tem; o que falta é criado depois da última coluna dele
  const ws = WB.Sheets[SHEET];
  const fimCliente = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).e.c + 1 : HEADERS.length;
  let prox = Math.max(HEADERS.length, fimCliente); const d={}; const novas=[];
  const ATIVO = {ncm:'ncm', cest:'cest', mva:'cest', cst:'icms', aliq:'icms', red:'icms', cfopS:'cfop', cfopE:'cfop',
                 ctCbs:'ibs', dsCbs:'ibs', cstCbs:'ibs', ctIbs:'ibs', dsIbs:'ibs', cstIbs:'ibs',
                 cstPis:'pis', cstPisE:'pis', aliqPis:'pis', aliqCofins:'pis', natRec:'pis', tribPc:'pis', estAb:'pis'};
  const simplesCli = regimeFederal(CLIENTE)==='simples';
  const SO_NORMAL = new Set(['cstPis','cstPisE','aliqPis','aliqCofins']);   // no Simples, PIS/Cofins vão no DAS
  const pede = (chave, titulo)=>{
    if(ESCOPO[ATIVO[chave]]===false) return undefined;
    const semColuna = MAPA[chave]==='' || MAPA[chave]===undefined;
    if(chave==='estAb' ? (!estAbAtivo() && semColuna) : (ATIVO[chave]==='pis' && !pcAtivo() && semColuna)) return undefined;
    if(simplesCli && SO_NORMAL.has(chave) && semColuna) return undefined;
    if(MAPA[chave]!=='' && MAPA[chave]!==undefined){
      const c=+MAPA[chave];
      if(!colunaTemFormula(c)) return c;
      titulo = titulo+' CORRIGIDO';          // coluna do cliente é fórmula (PROCV etc.): não sobrescreve
    }
    const i=prox++; novas.push([i,titulo]); return i;
  };
  d.ncm   = pede('ncm','NCM');
  d.cest  = pede('cest','CEST');
  d.cst   = pede('cst','CST/CSOSN ICMS');
  d.aliq  = pede('aliq','ALÍQUOTA ICMS (%)');
  d.red   = pede('red','REDUÇÃO BC ICMS (%)');
  d.mva   = pede('mva','MVA ST (%)');
  d.cfopS = pede('cfopS','CFOP SAÍDA');
  d.cfopE = pede('cfopE','CFOP ENTRADA');
  d.ctCbs = pede('ctCbs','CLASSTRIB CBS');
  d.dsCbs = pede('dsCbs','DESCRIÇÃO CLASSTRIB CBS');
  d.cstCbs= pede('cstCbs','CST CBS');
  d.ctIbs = pede('ctIbs','CLASSTRIB IBS');
  d.dsIbs = pede('dsIbs','DESCRIÇÃO CLASSTRIB IBS');
  d.cstIbs= pede('cstIbs','CST IBS');
  d.cstPis= pede('cstPis','CST PIS/COFINS SAÍDA');
  d.cstPisE=pede('cstPisE','CST PIS/COFINS ENTRADA');
  d.aliqPis=pede('aliqPis','ALÍQUOTA PIS (%)');
  d.aliqCofins=pede('aliqCofins','ALÍQUOTA COFINS (%)');
  d.natRec= pede('natRec','NATUREZA DA RECEITA');
  d.tribPc= simplesCli ? pede('tribPc','PIS/COFINS NO SIMPLES') : undefined;
  d.estAb = simplesCli ? undefined : pede('estAb','ESTOQUE ABERTURA CBS (F150)');
  return {d, novas};
}

function indexar(sheetData){
  const rows=sheetData.getElementsByTagName('row'), byRow=new Map(), nums=[];
  for(let k=0;k<rows.length;k++){ const rn=+(rows[k].getAttribute('r')||(k+1)); byRow.set(rn,{el:rows[k],cells:null}); nums.push(rn); }
  return {byRow,nums};
}
let FORMULAS_PRESERVADAS = 0;
function gravar(doc, sheetData, idx, linha, col, texto, limpar){
  const vazio = texto===undefined||texto===null||texto==='';
  if(vazio && !limpar) return;
  const NS=doc.documentElement.namespaceURI, ref=colL(col)+linha;
  let e=idx.byRow.get(linha);
  if(!e){ const row=doc.createElementNS(NS,'row'); row.setAttribute('r',String(linha));
    let before=null; for(const rn of idx.nums){ if(rn>linha){ before=idx.byRow.get(rn).el; break; } }
    sheetData.insertBefore(row,before); e={el:row,cells:new Map()}; idx.byRow.set(linha,e); idx.nums.push(linha); idx.nums.sort((a,b)=>a-b); }
  if(!e.cells){ e.cells=new Map(); const cs=e.el.getElementsByTagName('c');
    for(let k=0;k<cs.length;k++) e.cells.set(colI(cs[k].getAttribute('r')||''), cs[k]); }
  let cell=e.cells.get(col);
  if(cell && cell.getElementsByTagName('f').length){ FORMULAS_PRESERVADAS++; return; }   // fórmula do cliente fica
  if(vazio){ if(cell){ while(cell.firstChild) cell.removeChild(cell.firstChild); cell.removeAttribute('t'); } return; }
  if(!cell){ cell=doc.createElementNS(NS,'c'); cell.setAttribute('r',ref);
    let bc=null; const cs=e.el.getElementsByTagName('c');
    for(let k=0;k<cs.length;k++){ if(colI(cs[k].getAttribute('r')||'')>col){ bc=cs[k]; break; } }
    e.el.insertBefore(cell,bc); e.cells.set(col,cell); }
  while(cell.firstChild) cell.removeChild(cell.firstChild);
  cell.setAttribute('t','inlineStr');
  const is=doc.createElementNS(NS,'is'), t=doc.createElementNS(NS,'t');
  t.appendChild(doc.createTextNode(String(texto))); is.appendChild(t); cell.appendChild(is);
}

async function caminhoAba(zip){
  const dp=new DOMParser();
  const wbx=dp.parseFromString(await zip.file('xl/workbook.xml').async('string'),'application/xml');
  const relsF=zip.file('xl/_rels/workbook.xml.rels'); const rel={};
  if(relsF){ const rd=dp.parseFromString(await relsF.async('string'),'application/xml');
    const rs=rd.getElementsByTagName('Relationship');
    for(let k=0;k<rs.length;k++) rel[rs[k].getAttribute('Id')]=rs[k].getAttribute('Target'); }
  const shs=wbx.getElementsByTagName('sheet');
  for(let k=0;k<shs.length;k++){
    if(shs[k].getAttribute('name')!==SHEET) continue;
    let rid=shs[k].getAttribute('r:id') || (shs[k].getAttributeNS? shs[k].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id'):null);
    let p = rid? (rel[rid]||'').replace(/^\/+/,'').replace(/^\.\//,'') : '';
    if(p && !p.startsWith('xl/')) p='xl/'+p;
    if(!p || !zip.file(p)) p='xl/worksheets/sheet'+(k+1)+'.xml';
    if(zip.file(p)) return p;
  }
  return null;
}


/* ---------- abas de transparência: correções aplicadas e resumo ---------- */
const ROTULO_CAMPO = {ncm:'NCM', cest:'CEST', cst:'CST/CSOSN ICMS', cfopS:'CFOP saída',
                      aliq:'Alíquota ICMS', red:'Redução BC ICMS',
                      cfopE:'CFOP entrada', cclasstrib:'cClassTrib IBS/CBS',
                      cstPis:'CST PIS/COFINS saída', cstPisE:'CST PIS/COFINS entrada',
                      aliqPis:'Alíquota PIS', aliqCofins:'Alíquota COFINS', natRec:'Natureza da receita',
                      estAb:'Estoque de abertura CBS (F150)'};

function autoria(chave, campo){
  for(let k=TRILHA.length-1;k>=0;k--){ const t=TRILHA[k];
    if(t.chave===chave && t.campo===campo) return t; }
  return null;
}

/* o motivo que vai para o cliente: o enquadramento e por onde ele foi alcançado */
function fundamentoLegivel(it){
  const partes=[];
  if(it.ctDesc) partes.push(it.ctDesc);
  if(it.red && it.red!=='0%') partes.push('redução de '+it.red);
  if(it.regra && it.regra!=='—') partes.push('posição '+it.regra+' do anexo');
  if(it.nota) partes.push(it.nota);
  if(it.conf==='memoria'||it.memoriaGravada) partes.push('decisão registrada na memória da equipe');
  return partes.join(' · ');
}

let PREENCHIDOS = {};
/* o que o usuário pediu para corrigir, e como */
let ESCOPO = {ncm:true, cest:true, icms:true, ibs:true, cfop:true, pis:true, modo:'corrigir'};
function lerEscopo(){
  const ck = id=>{ const e=$(id); return e ? e.checked : true; };
  const m = document.querySelector('input[name="opModo"]:checked');
  return {ncm:ck('opNcm'), cest:ck('opCest'), icms:ck('opIcms'), ibs:ck('opIbs'), cfop:ck('opCfop'), pis:ck('opPis'),
          modo: m ? m.value : 'corrigir'};
}
const GRUPO_CAMPO = {ncm:'ncm', cest:'cest', mva:'cest', cst:'icms', aliq:'icms', red:'icms',
                     cfopS:'cfop', cfopE:'cfop', cclasstrib:'ibs',
                     cstPis:'pis', cstPisE:'pis', aliqPis:'pis', aliqCofins:'pis', natRec:'pis', estAb:'pis'};
/* indústria (CNAE divisões 10 a 33) destaca ICMS próprio mesmo com ST; comércio não */
function ehIndustria(cliente){
  const c = dig((cliente && cliente.cnae_principal) || ''); const div = +c.slice(0,2);
  return div>=10 && div<=33;
}
/* regime normal: mantém o dígito de origem que o cliente já usava (1xx importado etc.) */
function comOrigem(cst, cstOrig, cliente){
  const simples = cliente && (cliente.regime==='simples' || cliente.opcao_simples);
  if(simples) return cst;
  const d = dig(cstOrig||''); const origem = d.length===3 ? d[0] : '0';
  return origem + String(cst).slice(-2);
}
function linhasCorrecao(){
  const L=[]; PREENCHIDOS = {};
  const pct=v=>{ const t=String(v).replace('%','').replace(',','.').trim(); const n=parseFloat(t);
                 return isNaN(n)?t:String(n<=1&&n>0?+(n*100).toFixed(2):+n.toFixed(2)); };
  const add=(it,campo,de,para,motivo)=>{
    de=(de==null?'':String(de)).trim(); para=(para==null?'':String(para)).trim();
    if(['aliq','red'].includes(campo) && de && para) { de=pct(de); para=pct(para); }
    if(['aliqPis','aliqCofins'].includes(campo) && de && para){   // 0,65% não é fração: sem escala
      const n=v=>{ const x=parseFloat(String(v).replace('%','').replace(',','.')); return isNaN(x)?String(v):String(+x.toFixed(4)); };
      de=n(de); para=n(para); }
    if(['cstPis','cstPisE'].includes(campo) && de && para && dig(de).padStart(2,'0')===dig(para).padStart(2,'0')) return;
    if(!para || de===para) return;
    const grupo = GRUPO_CAMPO[campo]; if(grupo && !ESCOPO[grupo]) return;
    if(ESCOPO.modo==='vazios' && de && de!=='(em branco)'){
      // modo "só vazios": o valor do cliente foi mantido, mas a divergência fica registrada para conferência
      L.push([ it.i+1, it.desc||'', ROTULO_CAMPO[campo]||campo, de, para, motivo||'',
               'divergente — NÃO alterado (modo só preencher vazios)', '', '' ]); return; }
    const t=autoria(chaveItem(it), campo);
    // campo vazio preenchido pela base vai só para o resumo; decisão da equipe sempre vira linha
    if(!de && !t && campo!=='cest' && campo!=='ncm'){
      const rot = ROTULO_CAMPO[campo]||campo; PREENCHIDOS[rot]=(PREENCHIDOS[rot]||0)+1; return; }
    L.push([ it.i+1, it.desc||'', ROTULO_CAMPO[campo]||campo,
             de||'(em branco)', para, motivo||'',
             t ? (t.replicado?'replicado por fundamento':'corrigido pela equipe')
               : 'automático pela base oficial',
             t ? (t.por||'') : '', t ? (t.quando||'') : '' ]);
  };
  ITENS.forEach(it=>{
    add(it,'ncm',        it.ncmOrig,  it.ncm,  it.ncmMsg||'');
    add(it,'cest',       it.cestOrig, it.cest, it.st? (it.st.fundamento||'') : '');
    add(it,'cst',        it.cstOrig,  it.cst,  it.notaFiscal||'');
    add(it,'cfopE',      '',          it.cfopE, it.notaFiscal||'');
    add(it,'cfopS',      it.cfopSOrig,it.cfopS,'');
    add(it,'aliq',       it.aliqOrig, (it.st && it.aliq==='' && it.aliqOrig) ? 'sem destaque (ST)' : it.aliq, it.fundIcms||'');
    add(it,'red',        '',          it.redBc, it.fundIcms||'');
    add(it,'cclasstrib', it.ctOrig,   it.ct,   fundamentoLegivel(it));
    add(it,'cstPis',     it.cstPisOrig, it.cstPis, it.fundPc||'');
    add(it,'cstPisE',    it.cstPisEOrig, it.cstPisE, it.fundPc||'');
    add(it,'aliqPis',    it.aliqPisOrig, it.aliqPis, it.fundPc||'');
    add(it,'aliqCofins', it.aliqCofinsOrig, it.aliqCofins, it.fundPc||'');
    add(it,'natRec',     it.natRecOrig, it.natRec, it.fundPc||'');
    add(it,'estAb',      it.estAbOrig, it.estAb, it.fundEstAb||'');
  });
  return L;
}

function abaCorrecoes(){
  const L=linhasCorrecao();
  const m=[['CORREÇÕES APLICADAS NO CADASTRO'],
           ['Arquivo: '+RAWNAME+(CLIENTE?('  ·  Cliente: '+CLIENTE.nome+' ('+CLIENTE.uf+')'):'')
            +'  ·  Gerado em '+new Date().toLocaleString('pt-BR')],
           [],
           ['Linha','Produto','Campo','De','Para','Fundamento / motivo','Origem da correção','Responsável','Data']];
  if(!L.length) m.push(['—','Nenhum campo do cadastro precisou de correção.','','','','','','','']);
  return m.concat(L);
}

function abaResumo(){
  const TUDO=linhasCorrecao();
  const DIV=TUDO.filter(r=>String(r[6]).startsWith('divergente')), L=TUDO.filter(r=>!String(r[6]).startsWith('divergente'));
  const porCampo=new Map(); L.forEach(r=>porCampo.set(r[2],(porCampo.get(r[2])||0)+1));
  const porOrigem=new Map(); L.forEach(r=>porOrigem.set(r[6],(porOrigem.get(r[6])||0)+1));
  const porSit=new Map(); ITENS.forEach(i=>porSit.set(i.status,(porSit.get(i.status)||0)+1));
  const m=[['RESUMO DA CONFERÊNCIA'],
    ['Arquivo: '+RAWNAME+(CLIENTE?('  ·  Cliente: '+CLIENTE.nome+' ('+CLIENTE.uf+')  ·  Regime: '+(CLIENTE.regime||'—')):'')],
    ['Gerado em '+new Date().toLocaleString('pt-BR')+' por '+USER],
    [],
    ['Itens analisados', ITENS.length],
    ['Campos corrigidos', L.length],
    ['NCM preenchidos pela descrição (a conferir)', ITENS.filter(i=>i.ncmPorDescricao).length],
    ['NCM que podem não corresponder à descrição', ITENS.filter(i=>i.ncmIncoerente).length],
    ['CEST pelo Conv. ICMS 142/2018 sem ST no RN (a conferir)', ITENS.filter(i=>i.cestSugNac).length],
    ['CEST mantido pelo Conv. ICMS 142/2018 (sem ST no RN)', ITENS.filter(i=>i.cestNacional && !i.cestSugNac).length],
    ['CFOP inexistente ou no sentido errado', ITENS.filter(i=>i.cfopErro).length],
    ...(DIV.length?[['Divergências mantidas (modo só preencher vazios)', DIV.length]]:[]),
    ['Itens que vieram da memória da equipe', ITENS.filter(i=>i.memoriaGravada).length],
    ['Itens que seguem pendentes de revisão', ITENS.filter(i=>i.status==='rev'||i.ncmStatus==='erro').length],
    [],
    ['CORREÇÕES POR CAMPO','']];
  [...porCampo.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>m.push([k,v]));
  if(Object.keys(PREENCHIDOS).length){
    m.push([], ['CAMPOS PREENCHIDOS (estavam em branco na planilha)','']);
    Object.entries(PREENCHIDOS).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>m.push([k,v]));
  }
  m.push([], ['CORREÇÕES POR ORIGEM','']);
  [...porOrigem.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>m.push([k,v]));
  m.push([], ['ITENS POR SITUAÇÃO','']);
  [...porSit.entries()].forEach(([k,v])=>m.push([(SIT[k]?SIT[k][1]:k),v]));
  m.push([], ['Base legal do enquadramento IBS/CBS: LC 214/2025 e anexos; NCM conforme TIPI vigente'],
            ['Substituição tributária e CEST conforme anexo do RICMS da UF do cliente'],
            ...(pcExtinto() ? [['PIS/Cofins: extintos a partir de 01/01/2027 (EC 132/2023 — ADCT, art. 126, II); campos não preenchidos']]
               : !TEM_EXCECOES_PC() ? [['PIS/Cofins: não preenchidos — aguardando a carga das tabelas 4.3.10 a 4.3.17 da EFD-Contribuições (monofásico, alíquota zero, isenção, suspensão), sem as quais a regra geral erraria esses produtos']]
               : [['PIS/Cofins: regra geral do regime e exceções por NCM das tabelas '+[...new Set(REGRAS_PC.filter(r=>r.ncm).map(r=>r.tabela_sped))].sort().join(', ')
                   +' da EFD-Contribuições'+(()=>{ const f=['4.3.10','4.3.11','4.3.12','4.3.13','4.3.14','4.3.15','4.3.16','4.3.17'].filter(t=>!REGRAS_PC.some(r=>r.tabela_sped===t) && !TABELAS_PC.includes(t));
                      return f.length ? '; tabelas ainda não carregadas: '+f.join(', ')+' — itens dessas tabelas recebem a regra geral' : ''; })()
                   +'; válidos para fatos geradores até 31/12/2026']]),
            ...(estAbAtivo() ? [['Estoque de abertura da CBS: código da tabela "Descrição do Estoque de Abertura da CBS" (NT EFD-Contribuições 013/2026, Anexo V — conteúdo inicialmente previsto) para o registro F150, a escriturar até junho/2027']] : []),
            ['Este resumo é gerado pela ferramenta e não substitui a conferência final do responsável técnico']);
  return m;
}

/* injeta uma aba nova no arquivo original, sem formatação, sem mexer nas abas do cliente */
const xmlEsc = v => String(v==null?'':v).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                                        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
async function anexarAba(zip, nome, matriz){
  const dp=new DOMParser(), ser=new XMLSerializer();
  const ctf=zip.file('[Content_Types].xml'), wbf=zip.file('xl/workbook.xml'),
        rlf=zip.file('xl/_rels/workbook.xml.rels');
  if(!ctf||!wbf||!rlf) throw new Error('estrutura do arquivo não permite anexar abas');
  const ct=dp.parseFromString(await ctf.async('string'),'application/xml');
  const wb=dp.parseFromString(await wbf.async('string'),'application/xml');
  const rl=dp.parseFromString(await rlf.async('string'),'application/xml');

  let n=1; while(zip.file('xl/worksheets/sheet'+n+'.xml')) n++;
  const alvo='xl/worksheets/sheet'+n+'.xml';
  const rs=rl.getElementsByTagName('Relationship');
  let maxR=0; for(let k=0;k<rs.length;k++){ const m=/^rId(\d+)$/.exec(rs[k].getAttribute('Id')||''); if(m) maxR=Math.max(maxR,+m[1]); }
  const rid='rId'+(maxR+1);
  const shs=wb.getElementsByTagName('sheet');
  let maxId=0, nomes=[]; for(let k=0;k<shs.length;k++){ maxId=Math.max(maxId,+(shs[k].getAttribute('sheetId')||0));
    nomes.push(shs[k].getAttribute('name')); }
  let titulo=nome.slice(0,31), t=2; while(nomes.includes(titulo)) titulo=(nome.slice(0,28)+' '+t++);

  const linhas=matriz.map((r,i)=>'<row r="'+(i+1)+'">'+ (r||[]).map((v,j)=>{
      if(v===''||v===null||v===undefined) return '';
      const ref=colL(j)+(i+1);
      return (typeof v==='number')
        ? '<c r="'+ref+'"><v>'+v+'</v></c>'
        : '<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEsc(v)+'</t></is></c>';
    }).join('') +'</row>').join('');
  const larg=Math.max(1,...matriz.map(r=>(r||[]).length));
  zip.file(alvo, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    +'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    +'<dimension ref="A1:'+colL(larg-1)+Math.max(1,matriz.length)+'"/>'
    +'<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
    +'<sheetFormatPr defaultRowHeight="15"/>'
    +'<cols><col min="1" max="1" width="9"/><col min="2" max="2" width="46"/>'
    +'<col min="3" max="3" width="22"/><col min="4" max="5" width="18"/>'
    +'<col min="6" max="6" width="52"/><col min="7" max="7" width="26"/>'
    +'<col min="8" max="9" width="20"/></cols>'
    +'<sheetData>'+linhas+'</sheetData></worksheet>');

  const sEl=wb.createElementNS(wb.documentElement.namespaceURI,'sheet');
  sEl.setAttribute('name',titulo); sEl.setAttribute('sheetId',String(maxId+1));
  sEl.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','r:id',rid);
  wb.getElementsByTagName('sheets')[0].appendChild(sEl);
  zip.file('xl/workbook.xml', ser.serializeToString(wb));

  const rEl=rl.createElementNS(rl.documentElement.namespaceURI,'Relationship');
  rEl.setAttribute('Id',rid);
  rEl.setAttribute('Type','http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet');
  rEl.setAttribute('Target','worksheets/sheet'+n+'.xml');
  rl.documentElement.appendChild(rEl);
  zip.file('xl/_rels/workbook.xml.rels', ser.serializeToString(rl));

  const oEl=ct.createElementNS(ct.documentElement.namespaceURI,'Override');
  oEl.setAttribute('PartName','/'+alvo);
  oEl.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml');
  ct.documentElement.appendChild(oEl);
  zip.file('[Content_Types].xml', ser.serializeToString(ct));
  return titulo;
}

$('btnExportar').onclick = async ()=>{
  if(!ITENS.length){ toast('Nada para exportar.'); return; }
  if(/\.(xlsx|xlsm)$/i.test(RAWNAME) && typeof JSZip!=='undefined'){
    try{
      const zip=await JSZip.loadAsync(RAW.slice(0));
      const path=await caminhoAba(zip);
      if(!path) throw new Error('aba não localizada no arquivo');
      const doc=new DOMParser().parseFromString(await zip.file(path).async('string'),'application/xml');
      const sd=doc.getElementsByTagName('sheetData')[0];
      const idx=indexar(sd), {d,novas}=destinos();
      novas.forEach(([col,tit])=>gravar(doc,sd,idx,HR+1,col,tit));
      const ORIG = lerAba(SHEET); FORMULAS_PRESERVADAS = 0;
      const novasCols = new Set(novas.map(x=>x[0]));
      const W = (L, col, val, it, podeLimpar)=>{
        if(col===undefined) return;
        const antes = String(((ORIG[it.i]||[])[col]) ?? '').trim();
        if(ESCOPO.modo==='vazios' && antes!=='') return;
        // limpar só faz sentido em coluna do cliente, no modo corrigir (ex.: alíquota em item com ST)
        gravar(doc,sd,idx,L,col,val, podeLimpar && ESCOPO.modo==='corrigir' && !novasCols.has(col) && antes!=='');
      };
      let n=0;
      for(const it of ITENS){
        const L=it.i+1;                       // linha absoluta do Excel
        W(L,d.ncm,   it.ncm,   it);
        W(L,d.cest,  it.cest,  it, true);
        W(L,d.mva,   it.mva,   it, true);
        W(L,d.cst,   it.cst,   it);
        W(L,d.aliq,  it.aliq,  it, true);
        W(L,d.red,   it.redBc, it, true);
        W(L,d.cfopS, it.cfopS, it);
        W(L,d.cfopE, it.cfopE, it);
        W(L,d.ctCbs, it.ct,    it);
        W(L,d.dsCbs, it.ctDesc,it);
        W(L,d.cstCbs,it.cstTrib,it);
        W(L,d.ctIbs, it.ct,    it);
        W(L,d.dsIbs, it.ctDesc,it);
        W(L,d.cstIbs,it.cstTrib,it);
        W(L,d.cstPis,it.cstPis,it);
        W(L,d.cstPisE,it.cstPisE,it);
        W(L,d.aliqPis,it.aliqPis,it,true);
        W(L,d.aliqCofins,it.aliqCofins,it,true);
        W(L,d.natRec,it.natRec,it,true);
        W(L,d.tribPc,it.tribPc,it);
        W(L,d.estAb,it.estAb,it,true);
        if(++n%800===0) await new Promise(r=>setTimeout(r,0));
      }
      const dim=doc.getElementsByTagName('dimension')[0];
      if(dim){ const m=(dim.getAttribute('ref')||'').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if(m){ const max=Math.max(colI(m[3]), ...Object.values(d).filter(v=>v!==undefined)); dim.setAttribute('ref', m[1]+m[2]+':'+colL(max)+m[4]); } }
      zip.file(path, new XMLSerializer().serializeToString(doc));
      let nCorr=0;
      try{
        const corr=abaCorrecoes(); nCorr=Math.max(0,corr.length-4);
        await anexarAba(zip,'CORREÇÕES APLICADAS',corr);
        await anexarAba(zip,'RESUMO DA CONFERÊNCIA',abaResumo());
      }catch(e){ console.warn('abas de transparência:',e); }
      baixar(await zip.generateAsync({type:'blob'}), RAWNAME.replace(/\.(xlsx|xlsm)$/i,'')+'_preenchida.xlsx');
      toast(`Planilha exportada com <b>${ITENS.length}</b> itens preenchidos, mantendo a formatação original`
            + (nCorr? `, e uma aba com as <b>${nCorr}</b> correções aplicadas.` : '.'));
      return;
    }catch(err){ console.warn(err); toast('Não consegui preservar a formatação — exportando em formato simples.'); }
  }
  const aoa=lerAba(SHEET);
  const {d,novas}=destinos();
  novas.forEach(([c,t])=>{ aoa[HR][c]=t; });
  const dv = Object.fromEntries(Object.entries(d).map(([k,v])=>[k, v===undefined?-1:v]));
  ITENS.forEach(it=>{ const row=aoa[it.i]; if(!row) return;
    while(row.length<=Math.max(...Object.values(dv))) row.push('');
    row[d.ncm]=it.ncm; row[d.cest]=it.cest||''; row[d.cst]=it.cst; row[d.cfopS]=it.cfopS; row[d.cfopE]=it.cfopE;
    row[d.aliq]=it.aliq||''; row[d.red]=it.redBc||''; row[d.mva]=it.mva||'';
    row[d.ctCbs]=it.ct; row[d.dsCbs]=it.ctDesc; row[d.cstCbs]=it.cstTrib;
    row[d.ctIbs]=it.ct; row[d.dsIbs]=it.ctDesc; row[d.cstIbs]=it.cstTrib;
    row[d.cstPis]=it.cstPis||''; row[d.cstPisE]=it.cstPisE||''; row[d.aliqPis]=it.aliqPis||'';
    row[d.aliqCofins]=it.aliqCofins||''; row[d.natRec]=it.natRec||''; row[d.estAb]=it.estAb||''; });
  const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(aoa), SHEET);
  const corr=abaCorrecoes();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(corr), 'CORREÇÕES APLICADAS');
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(abaResumo()), 'RESUMO DA CONFERÊNCIA');
  baixar(new Blob([XLSX.write(wb2,{bookType:'xlsx',type:'array'})],{type:'application/octet-stream'}),
         (RAWNAME.replace(/\.[^.]+$/,'')||'planilha')+'_preenchida.xlsx');
  toast(`Planilha exportada com <b>${ITENS.length}</b> itens preenchidos e <b>${Math.max(0,corr.length-4)}</b> correções registradas.`);
};

$('btnCsv').onclick=()=>{
  const h=['Linha','Produto','NCM original','NCM','Situação','CSOSN/CST','CFOP saída','CFOP entrada','cClassTrib','CST IBS/CBS','Redução','Observação'];
  const l=[h.join(';')].concat(ITENS.map(i=>[i.i+1,`"${(i.desc||'').replace(/"/g,'""')}"`,i.ncmOrig,i.ncm,
    SIT[i.status][1],i.cst,i.cfopS,i.cfopE,i.ct,i.cstTrib,i.red||'',
    `"${[i.ncmMsg,i.nota,i.notaFiscal].filter(Boolean).join(' | ').replace(/"/g,'""')}"`].join(';')));
  baixar(new Blob(['﻿'+l.join('\n')],{type:'text/csv;charset=utf-8'}),'relatorio_'+NOME_PRODUTO.arquivo+'.csv');
};
function baixar(blob,nome){ const u=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=u; a.download=nome; document.body.appendChild(a); a.click();
  setTimeout(()=>{document.body.removeChild(a); URL.revokeObjectURL(u);},1500); }

/* ============================ CLIENTES ============================ */
$('cnpj').oninput=e=>{ const d=dig(e.target.value).slice(0,14);
  e.target.value=d.replace(/^(\d{2})(\d{3})?(\d{3})?(\d{4})?(\d{2})?$/,(m,a,b,c,f,g)=>
    [a,b&&'.'+b,c&&'.'+c,f&&'/'+f,g&&'-'+g].filter(Boolean).join('')); };

let CNPJ_DADOS=null;
$('btnCnpj').onclick = async ()=>{
  const d=dig($('cnpj').value);
  if(d.length!==14){ $('cnpjMsg').textContent='Informe os 14 dígitos.'; return; }
  $('cnpjMsg').textContent='Consultando…'; $('cnpjRes').hidden=true;
  let j=null;
  for(const url of [`https://brasilapi.com.br/api/cnpj/v1/${d}`, `https://minhareceita.org/${d}`]){
    try{ const r=await fetch(url); if(r.ok){ j=await r.json(); break; } }catch(e){}
  }
  if(!j){ $('cnpjMsg').textContent='Não foi possível consultar agora. Tente novamente ou preencha manualmente.'; return; }
  CNPJ_DADOS=j; $('cnpjMsg').textContent='';
  const simples = j.opcao_pelo_simples===true, mei = j.opcao_pelo_mei===true;
  const campos=[
    ['Razão social', j.razao_social||j.nome||''],
    ['Nome fantasia', j.nome_fantasia||''],
    ['UF', j.uf||''], ['Município', j.municipio||''],
    ['CNAE principal', (j.cnae_fiscal||'')+' — '+(j.cnae_fiscal_descricao||'')],
    ['Porte', j.descricao_porte||j.porte||''],
    ['Situação cadastral', j.descricao_situacao_cadastral||j.situacao_cadastral||''],
    ['Simples Nacional', simples?'Optante':'Não optante'],
    ['MEI', mei?'Optante':'Não']
  ];
  $('cnpjGrid').innerHTML = campos.map(([r,v])=>`<div><label class="f">${r}</label><input value="${esc(v)}" readonly></div>`).join('')
    + `<div><label class="f">Regime tributário</label><select id="regimeSel">
        <option value="simples" ${simples&&!mei?'selected':''}>Simples Nacional</option>
        <option value="mei" ${mei?'selected':''}>MEI</option>
        <option value="presumido" ${!simples&&!mei?'selected':''}>Lucro Presumido</option>
        <option value="real">Lucro Real</option></select></div>`;
  $('avisoRegime').hidden = simples||mei;
  $('avisoRegime').innerHTML = 'A base pública informa apenas Simples e MEI. Para empresa não optante, <b>Presumido x Real não é dado público</b> — confirme o regime acima antes de usar, porque ele define se o cadastro usa CSOSN ou CST.';
  $('cnpjRes').hidden=false;
};

$('btnSalvarCliente').onclick = async ()=>{
  if(!CNPJ_DADOS) return;
  const j=CNPJ_DADOS, regime=$('regimeSel').value;
  const reg = {
    nome: j.razao_social||j.nome||'(sem nome)', cnpj: dig($('cnpj').value), uf: j.uf||'',
    regime, municipio: j.municipio||null,
    cnae_principal: String(j.cnae_fiscal||''), cnae_principal_desc: j.cnae_fiscal_descricao||null,
    cnaes_secundarios: j.cnaes_secundarios||j.cnaes_secundarias||null,
    porte: j.descricao_porte||j.porte||null,
    situacao_cadastral: j.descricao_situacao_cadastral||String(j.situacao_cadastral||''),
    opcao_simples: j.opcao_pelo_simples===true, opcao_mei: j.opcao_pelo_mei===true,
    regime_confirmado: (j.opcao_pelo_simples===true || j.opcao_pelo_mei===true),
    cadastro_consultado_em: new Date().toISOString(), cadastro_fonte: 'consulta pública de CNPJ'
  };
  const {error} = await sb.from('clientes').insert(reg);
  if(error){ toast('Falha ao salvar: '+error.message); return; }
  toast('Cliente salvo. O regime passa a comandar o preenchimento do cadastro de produtos.');
  $('cnpjRes').hidden=true; $('cnpj').value=''; carregarClientes();
};

async function carregarClientes(){
  const {data} = await sb.from('clientes').select('*').order('nome');
  CLIENTES=data||[];
  $('selCliente').innerHTML='<option value="">— selecione o cliente —</option>'
    + CLIENTES.map(c=>`<option value="${c.id}">${esc(c.nome)} · ${c.uf} · ${c.regime}</option>`).join('');
  $('tbClientes').innerHTML = CLIENTES.length? CLIENTES.map(c=>`<tr>
      <td>${esc(c.nome)}</td><td class="mono">${esc(c.cnpj||'')}</td><td class="mono">${esc(c.uf||'')}</td>
      <td>${esc(c.regime)}${c.regime_confirmado?'':' <span class="chip c-rev">confirmar</span>'}</td>
      <td class="muted">${esc((c.cnae_principal_desc||'').slice(0,40))}</td>
      <td class="muted">${esc(c.situacao_cadastral||'')}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Nenhum cliente ainda — consulte um CNPJ acima.</td></tr>';
  kpisBase();
}

/* ============================ ATUALIZAÇÕES ============================ */
$('btnRecarregar').onclick=()=>{ carregarAtos(); carregarFontes(); };
async function carregarAtos(){
  const {data,error} = await sb.from('atualizacao_legislativa').select('*').order('detectado_em',{ascending:false}).limit(200);
  if(error){ $('tbAtos').innerHTML=`<tr><td colspan="7" class="muted">${esc(error.message)}</td></tr>`; return; }
  $('tbAtos').innerHTML = (data&&data.length)? data.map(a=>`<tr>
      <td class="mono">${(a.detectado_em||'').slice(0,10)}</td>
      <td>${a.url?`<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.ato)}</a>`:esc(a.ato)}
          <div class="muted">${esc((a.ementa||'').slice(0,110))}</div></td>
      <td class="muted">${esc(a.fonte)}</td>
      <td><span class="chip c-intg">${esc(a.impacto||'—')}</span></td>
      <td class="mono">${a.efeitos_em||'—'}</td>
      <td><span class="chip ${a.situacao==='aplicado'?'c-ok':a.situacao==='novo'?'c-rev':'c-intg'}">${esc(a.situacao)}</span></td>
      <td>${a.situacao==='novo'?`<button class="btn quiet" data-ato="${a.id}">Marcar analisado</button>`:''}</td>
    </tr>`).join('')
    : '<tr><td colspan="7" class="muted">Nenhum ato registrado ainda. A primeira varredura roda amanhã às 6h31.</td></tr>';
  $('tbAtos').querySelectorAll('button[data-ato]').forEach(b=>b.onclick=async()=>{
    await sb.from('atualizacao_legislativa').update({situacao:'analisado'}).eq('id',b.dataset.ato);
    carregarAtos();
  });
}

/* ---------- fontes vigiadas por hash ---------- */
const dataHora = v => v ? new Date(v).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}) : '—';
async function carregarFontes(){
  const {data,error} = await sb.from('fonte_vigiada').select('id,trilho,uf,nome,url,modo,verificado_em,alterado_em,ultimo_status,erro,ativo').order('trilho').order('id');
  if(!$('tbFontes')) return;
  if(error){ $('tbFontes').innerHTML=`<tr><td colspan="5" class="muted">${esc(error.message)}</td></tr>`; return; }
  $('btnVerificarFontes').hidden = !EH_ADMIN;
  $('tbFontes').innerHTML = (data&&data.length) ? data.map(f=>`<tr>
      <td>${f.trilho==='federal'?'Federal':'Estadual'+(f.uf?' · '+esc(f.uf):'')}</td>
      <td><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.nome)}</a></td>
      <td class="mono">${dataHora(f.verificado_em)}</td>
      <td class="mono">${dataHora(f.alterado_em)}</td>
      <td>${!f.ativo?'<span class="chip c-intg">pausada</span>'
           : f.erro?`<span class="chip c-err" title="${esc(f.erro)}">sem acesso</span>`
           : f.verificado_em?'<span class="chip c-ok">vigiando</span>':'<span class="chip c-rev">aguardando 1ª leitura</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted">Nenhuma fonte cadastrada.</td></tr>';
}
if($('btnVerificarFontes')) $('btnVerificarFontes').onclick = async ()=>{
  $('btnVerificarFontes').disabled=true; toast('Conferindo as fontes oficiais…');
  const {data,error} = await sb.functions.invoke('vigia-fontes',{body:{origem:'manual'}});
  $('btnVerificarFontes').disabled=false;
  if(error){ toast('Não foi possível verificar: '+esc(error.message)); return; }
  toast(`<b>${data.verificadas}</b> fonte(s) conferida(s), <b>${data.alteradas}</b> com alteração.`);
  carregarFontes(); carregarAtos();
};

/* ============================ MEMÓRIA ============================ */
async function carregarMemoria(){
  const {data} = await sb.from('memoria_correcao').select('*').order('criado_em',{ascending:false}).limit(100);
  $('tbMemoria').innerHTML = (data&&data.length)? data.map(m=>`<tr>
      <td class="mono">${esc(m.ncm||'')}</td><td class="muted">${esc((m.descricao_norm||'').slice(0,40))}</td>
      <td>${esc(m.campo)}</td><td class="mono">${esc(m.valor)}</td>
      <td class="muted">${esc((m.usuario||'').split('@')[0])}</td><td class="mono">${(m.criado_em||'').slice(0,10)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Nenhuma correção registrada ainda.</td></tr>';
}

/* ============================ CARGA DE TABELA OFICIAL ============================ */
$('btnCarregarBase').onclick = async ()=>{
  const f=$('fileBase').files[0], tabela=$('selTabela').value;
  if(!f){ $('baseMsg').textContent='Selecione o arquivo.'; return; }
  $('baseMsg').textContent='Lendo arquivo…';
  const buf=await f.arrayBuffer();
  const wb=XLSX.read(new Uint8Array(buf),{type:'array'});
  const linhas=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
  if(!linhas.length){ $('baseMsg').textContent='Arquivo vazio.'; return; }
  const chaves=Object.keys(linhas[0]).map(norm);
  const acha=(...alvos)=>Object.keys(linhas[0])[chaves.findIndex(k=>alvos.some(a=>k.includes(a)))];
  let regs=[];
  if(tabela==='tipi'){
    const kN=acha('ncm','codigo'), kD=acha('descri'), kA=acha('aliquota','ipi');
    regs = linhas.map(l=>({ncm:dig(l[kN]).padStart(8,'0').slice(0,8), descricao:String(l[kD]||'').slice(0,400),
      aliquota_ipi:String(l[kA]??'').trim()||'NT', vigencia_ini:'2026-02-01', fonte:'TIPI — Decreto 11.158/2022 c/ ADE RFB 1/2026'}))
      .filter(r=>r.ncm.length===8 && /^\d{8}$/.test(r.ncm));
  } else { $('baseMsg').textContent='Carga desta tabela ainda não implementada — me avise o layout do arquivo.'; return; }
  $('baseMsg').textContent=`Gravando ${regs.length} linhas…`;
  let ok=0;
  for(let i=0;i<regs.length;i+=500){
    const {error}=await sb.from(tabela).upsert(regs.slice(i,i+500),{onConflict:'ncm'});
    if(error){ $('baseMsg').textContent='Erro na gravação: '+error.message; return; }
    ok+=Math.min(500, regs.length-i); $('baseMsg').textContent=`Gravando… ${ok}/${regs.length}`;
  }
  $('baseMsg').textContent=`${ok} NCMs carregados.`;
  toast(`Base atualizada: <b>${ok}</b> NCMs da TIPI gravados. A validação de NCM extinto já está ativa.`);
  carregarBase();
};

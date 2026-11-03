/* ============================================================
   MIX FISCAL · ELITE
   Front-end do preenchimento de cadastro fiscal de produtos.
   Banco: Supabase (projeto mix-fiscal-elite, região sa-east-1)
   ============================================================ */
const SB_URL  = 'https://mxsznvkksqeogkkgoylo.supabase.co';
const SB_KEY  = 'sb_publishable_U4WfRm7NFfhY86yLHAjPZw_9mFW5Es0';
const DOMINIO = '@eliteconsultores.com.br';     // o banco também valida isto por RLS
const sb = supabase.createClient(SB_URL, SB_KEY);

const $  = id => document.getElementById(id);
const norm = s => (s??'').toString().trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const dig  = s => (s??'').toString().replace(/\D/g,'');
const esc  = s => (s??'').toString().replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let toastT=null;
function toast(html, ms=5000){ const t=$('toast'); t.innerHTML=html; t.classList.add('show');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'), ms); }

/* estado */
let USER=null, CLIENTES=[], CLIENTE=null, BASE=new Map(), META=new Map(), TIPI=new Set();
let WB=null, RAW=null, RAWNAME='', SHEET='', HR=0, HEADERS=[], MAPA={}, ITENS=[], FILTRO='all';

/* ============================ AUTENTICAÇÃO ============================ */
$('gateForm').addEventListener('submit', async e=>{
  e.preventDefault(); $('gErr').textContent='';
  const email=$('gEmail').value.trim().toLowerCase(), pass=$('gPass').value;
  if(!email.endsWith(DOMINIO)){ $('gErr').textContent='E-mail não autorizado para esta ferramenta.'; return; }
  $('gBtn').disabled=true;
  const {error} = await sb.auth.signInWithPassword({email, password:pass});
  $('gBtn').disabled=false;
  if(error){ $('gErr').textContent = /Invalid login/i.test(error.message) ? 'Credenciais inválidas.' : error.message; return; }
  entrar();
});
$('gSignup').onclick = async ()=>{
  $('gErr').textContent='';
  const email=$('gEmail').value.trim().toLowerCase(), pass=$('gPass').value;
  if(!email.endsWith(DOMINIO)){ $('gErr').textContent='E-mail não autorizado para esta ferramenta.'; return; }
  if(pass.length<8){ $('gErr').textContent='Defina uma senha com ao menos 8 caracteres.'; return; }
  const {error}=await sb.auth.signUp({email, password:pass});
  if(error){ $('gErr').textContent=error.message; return; }
  $('gErr').textContent='';
  toast('Conta criada. Se o projeto exigir confirmação, abra o link enviado ao seu e-mail e entre em seguida.', 9000);
};
/* Entrada pela conta Google do escritório (Workspace). O parâmetro hd pede ao
   Google que só ofereça contas do domínio; a checagem final é feita aqui e no
   banco (RLS), porque o hd sozinho não é barreira de segurança. */
$('gGoogle').onclick = async ()=>{
  $('gErr').textContent='';
  const {error} = await sb.auth.signInWithOAuth({
    provider:'google',
    options:{ redirectTo: location.origin + location.pathname,
              queryParams:{ hd: DOMINIO.replace('@',''), prompt:'select_account' } }
  });
  if(error) $('gErr').textContent = /provider is not enabled/i.test(error.message)
    ? 'O login pelo Google ainda não está habilitado no projeto Supabase (Authentication → Providers → Google).'
    : error.message;
};
/* volta do redirecionamento do Google */
sb.auth.onAuthStateChange((evt, session)=>{
  if(evt==='SIGNED_IN' && session && !USER) entrar();
});
$('btnSair').onclick = async ()=>{ await sb.auth.signOut(); location.reload(); };

async function entrar(){
  const {data:{user}} = await sb.auth.getUser();
  if(!user){ return; }
  if(!user.email || !user.email.endsWith(DOMINIO)){        // vale também para a volta do Google
    await sb.auth.signOut();
    $('gate').hidden=false; $('app').hidden=true;
    $('gErr').textContent='Esta conta Google não pertence ao domínio autorizado.';
    return;
  }
  USER=user.email;
  $('gate').hidden=true; $('app').hidden=false;
  const [u,d]=USER.split('@');
  $('whoami').textContent = u+'@'+d.slice(0,2)+'•'.repeat(Math.max(3,d.length-6))+d.slice(-7);
  await Promise.all([carregarBase(), carregarClientes()]);
  carregarAtos(); carregarMemoria();
}
sb.auth.getSession().then(({data:{session}})=>{ if(session) entrar(); });

/* ============================ NAVEGAÇÃO ============================ */
document.querySelectorAll('.navitem').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.navitem').forEach(x=>x.classList.remove('on'));
  document.querySelectorAll('.tela').forEach(x=>x.classList.remove('on'));
  b.classList.add('on'); $('tela-'+b.dataset.tela).classList.add('on');
  if(b.dataset.tela==='atualizacoes') carregarAtos();
  if(b.dataset.tela==='base'){ carregarMemoria(); kpisBase(); }
});

/* ============================ BASE DE REFERÊNCIA ============================ */
async function carregarBase(){
  const [{data:anexos}, {data:metas}] = await Promise.all([
    sb.from('ibs_cbs_anexo').select('ncm,cclasstrib,cst,exige,exclui,condicao').limit(5000),
    sb.from('cclasstrib_meta').select('*')
  ]);
  BASE.clear(); META.clear();
  (anexos||[]).forEach(r=>{ if(!BASE.has(r.ncm)) BASE.set(r.ncm,[]); BASE.get(r.ncm).push(r); });
  (metas||[]).forEach(m=>META.set(m.cclasstrib,m));
  const {data:tipi} = await sb.from('tipi').select('ncm').limit(20000);
  TIPI.clear(); (tipi||[]).forEach(r=>TIPI.add(r.ncm));
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
      const m=META.get('000001')||{};
      return {ct:'000001', cst:'000', desc:m.descricao||'Tributação integral', red:'0%', conf:'rev', regra,
              nota:'Benefício NÃO aplicado — '+okList[0].c.motivo+' Enquadramento possível: '+hits.map(h=>h.cclasstrib).join(' / ')+'.'};
    }
    const m=META.get(escolhido.h.cclasstrib)||{};
    const varios = hits.length>1;
    const condicional = !!(escolhido.h.exige||escolhido.h.exclui);
    return {ct:escolhido.h.cclasstrib, cst:escolhido.h.cst, desc:m.descricao||'', red:m.reducao||'',
            conf: (varios||condicional||len<6) ? 'rev' : 'ok', regra,
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

function validarNcm(bruto){
  const d = dig(bruto);
  if(!d) return {ncm:'', status:'err', msg:'NCM ausente'};
  if(d.length===8){
    // só acusa NCM inexistente quando a TIPI está carregada por inteiro (>10 mil códigos);
    // com carga parcial a checagem acusaria falso positivo em tudo
    if(TIPI.size>8000 && !TIPI.has(d)) return {ncm:d, status:'err', msg:'NCM não consta na TIPI vigente — risco de Rejeição 778'};
    return {ncm:d, status:'ok', msg: TIPI.size>8000 ? '' : ''};
  }
  if(d.length===7) return {ncm:'0'+d, status:'rev', msg:'NCM com 7 dígitos — provável zero à esquerda; corrigido para '+('0'+d)+', confirme'};
  return {ncm:d, status:'err', msg:'NCM com '+d.length+' dígitos — inválido'};
}

/* CSOSN/CST e CFOP conforme o regime do cliente e a presença de ST */
function fiscalPorRegime(item, cliente){
  const simples = cliente && (cliente.regime==='simples' || cliente.opcao_simples);
  const temST = !!item.cestOrig || /^(500|60|10|70)/.test(String(item.cstOrig||''));
  const out = {};
  if(simples){
    out.cst   = temST ? '500' : '102';
    out.cfopS = temST ? '5405' : '5102';
    out.cfopE = temST ? '1403' : '1102';
    out.nota  = 'Simples Nacional: CSOSN '+out.cst+(temST?' (mercadoria com ST)':' (sem ST)');
  } else {
    out.cst   = temST ? '060' : '000';
    out.cfopS = temST ? '5405' : '5102';
    out.cfopE = temST ? '1403' : '1102';
    out.nota  = 'Regime normal: CST '+out.cst+(temST?' (ST já recolhida)':'');
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
    SHEET = WB.SheetNames[0];
    const aoa=XLSX.utils.sheet_to_json(WB.Sheets[SHEET],{header:1,defval:''});
    HR=0; for(let i=0;i<Math.min(aoa.length,10);i++){ if((aoa[i]||[]).filter(c=>typeof c==='string'&&c.trim()).length>=3){HR=i;break;} }
    HEADERS=(aoa[HR]||[]).map((h,i)=>(h+'').trim()||('Coluna '+XLSX.utils.encode_col(i)));
    await montarMapa();
    $('p2').hidden=false;
    $('infoArq').textContent = `${aoa.length-HR-1} linhas · ${HEADERS.length} colunas · aba "${SHEET}"`;
    $('mapOrigem').textContent = CLIENTE && MAPA.__salvo ? '— mapeamento salvo deste cliente' : '— detectado automaticamente';
  };
  rd.readAsArrayBuffer(f);
}

const CAMPOS = [
  ['desc',  'Descrição do produto', ['produto','descricao','descrição','item','mercadoria']],
  ['ncm',   'NCM',                  ['ncm']],
  ['cest',  'CEST',                 ['cest']],
  ['cst',   'CST/CSOSN ICMS',       ['cst/csosn','csosn','cst icms']],
  ['aliq',  'Alíquota ICMS',        ['aliquota icms','alíquota icms']],
  ['cfopS', 'CFOP saída',           ['cfop saida','cfop saída']],
  ['cfopE', 'CFOP entrada',         ['cfop entrada']],
  ['ctCbs', 'cClassTrib CBS',       ['classtrib cbs']],
  ['dsCbs', 'Descrição cClassTrib CBS', ['descricao classtrib cbs','descrição classtrib cbs']],
  ['cstCbs','CST CBS',              ['cst cbs']],
  ['ctIbs', 'cClassTrib IBS',       ['classtrib ibs']],
  ['dsIbs', 'Descrição cClassTrib IBS', ['descricao classtrib ibs','descrição classtrib ibs']],
  ['cstIbs','CST IBS',              ['cst ibs']]
];

async function montarMapa(){
  MAPA={};
  if(CLIENTE){
    const {data} = await sb.from('clientes').select('observacoes').eq('id',CLIENTE.id).maybeSingle();
    try{ const salvo=JSON.parse((data&&data.observacoes)||'{}').mapa;
      if(salvo && salvo.__headers===HEADERS.join('|')){ MAPA={...salvo,__salvo:true}; }
    }catch(e){}
  }
  const nh=HEADERS.map(norm);
  CAMPOS.forEach(([k,,alvos])=>{
    if(MAPA[k]!==undefined) return;
    let i=nh.findIndex(h=>alvos.some(a=>h===norm(a)));
    if(i<0) i=nh.findIndex(h=>alvos.some(a=>h.includes(norm(a))));
    MAPA[k]= i>=0? i : '';
  });
  $('mapGrid').innerHTML = CAMPOS.map(([k,rot])=>`
    <div><label class="f">${rot}</label>
      <select data-campo="${k}">
        <option value="">— não usar —</option>
        ${HEADERS.map((h,i)=>`<option value="${i}" ${String(MAPA[k])===String(i)?'selected':''}>${esc(h)}</option>`).join('')}
      </select></div>`).join('');
  $('mapGrid').querySelectorAll('select').forEach(s=>s.onchange=()=>{ MAPA[s.dataset.campo]= s.value===''?'':+s.value; });
}

$('btnSalvarMapa').onclick = async ()=>{
  if(!CLIENTE){ toast('Selecione o cliente antes de salvar o mapeamento.'); return; }
  const mapa={...MAPA, __headers:HEADERS.join('|')}; delete mapa.__salvo;
  const {error} = await sb.from('clientes').update({observacoes: JSON.stringify({mapa})}).eq('id',CLIENTE.id);
  toast(error? 'Falha ao salvar: '+error.message : 'Mapeamento salvo — da próxima planilha deste cliente ele já vem pronto.');
};

/* ============================ PASSO 2 · PREENCHER ============================ */
$('selCliente').onchange = e=>{ CLIENTE = CLIENTES.find(c=>c.id===e.target.value)||null; };

$('btnRodar').onclick = ()=>{
  if(MAPA.ncm==='' || MAPA.ncm===undefined){ toast('Indique a coluna de NCM.'); return; }
  const aoa=XLSX.utils.sheet_to_json(WB.Sheets[SHEET],{header:1,defval:''});
  ITENS=[];
  aoa.slice(HR+1).forEach((r,idx)=>{
    if(!r.some(c=>(c+'').trim()!=='')) return;
    const bruto = r[MAPA.ncm];
    if((bruto+'').trim()==='') return;
    const v = validarNcm(bruto);
    const item = {
      i:idx,
      desc: MAPA.desc!=='' ? (r[MAPA.desc]+'').trim() : '',
      ncmOrig: (bruto+'').trim(),
      ncm: v.ncm, ncmStatus: v.status, ncmMsg: v.msg,
      cestOrig: MAPA.cest!=='' ? (r[MAPA.cest]+'').trim() : '',
      cstOrig:  MAPA.cst!==''  ? (r[MAPA.cst]+'').trim()  : '',
      cfopSOrig:MAPA.cfopS!==''? (r[MAPA.cfopS]+'').trim(): ''
    };
    const a = classificarIbsCbs(item.ncm, item.desc);
    item.ct=a.ct; item.cstTrib=a.cst; item.ctDesc=a.desc; item.red=a.red; item.regra=a.regra;
    item.nota=a.nota||''; item.confIbs=a.conf;
    const f = fiscalPorRegime(item, CLIENTE);
    item.cst = item.cstOrig || f.cst;  item.cstSug = !item.cstOrig;
    item.cfopS = item.cfopSOrig || f.cfopS; item.cfopSSug = !item.cfopSOrig;
    item.cfopE = f.cfopE; item.cfopESug = true;   // vazio em toda a planilha: sempre sugestão
    item.notaFiscal = f.nota;
    item.status = item.ncmStatus==='err' ? 'err'
                : (item.confIbs==='rev' || item.cstSug || item.ncmStatus==='rev') ? 'rev' : 'ok';
    ITENS.push(item);
  });
  detectarNcmGenerico(ITENS);
  aplicarMemoria().then(()=>{ $('p3').hidden=false; FILTRO='all'; kpis(); tabela();
    $('p3').scrollIntoView({behavior:'smooth'});
    toast(`<b>${ITENS.length}</b> itens processados. ${ITENS.filter(i=>i.status!=='ok').length} precisam de conferência.`); });
};

async function aplicarMemoria(){
  if(!ITENS.length) return;
  const {data} = await sb.from('memoria_correcao').select('*')
    .eq('cliente_id', CLIENTE? CLIENTE.id : null).limit(5000);
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

function tabela(){
  const q=norm($('busca').value);
  const linhas=ITENS.filter(i=>(FILTRO==='all'||i.status===FILTRO) && (!q || norm(i.desc).includes(q) || i.ncm.includes(q)));
  $('infoFiltro').textContent=`${linhas.length} de ${ITENS.length} itens`;
  const opts = [...META.entries()].map(([k,m])=>`<option value="${k}">${k} · ${esc((m.descricao||'').slice(0,42))}</option>`).join('');
  $('tbody').innerHTML = linhas.slice(0,600).map(it=>{
    const [cl,rot]=SIT[it.status];
    const msg = [it.ncmMsg, it.nota, it.notaFiscal].filter(Boolean).join(' · ');
    return `<tr>
      <td class="mono">${it.i+2+HR}</td>
      <td>${esc(it.desc)||'<span class="muted">—</span>'}<div class="muted">${esc(msg)}</div></td>
      <td class="mono ${it.ncm!==dig(it.ncmOrig)?'fill':''}">${it.ncm||esc(it.ncmOrig)}</td>
      <td class="mono ${it.cstSug?'fill':''}">${it.cst}</td>
      <td class="mono ${it.cfopSSug?'fill':''}">${it.cfopS}</td>
      <td class="mono ${it.cfopESug?'fill':''}">${it.cfopE}</td>
      <td class="mono fill">${it.ct}<div class="muted">${esc((it.ctDesc||'').slice(0,40))}</div></td>
      <td class="mono fill">${it.cstTrib}</td>
      <td><span class="chip ${cl}">${rot}</span>${it.porMemoria?`<div class="muted">${esc(it.porMemoria)}</div>`:''}</td>
      <td><select class="mini" data-i="${it.i}"><option value="">— alterar cClassTrib —</option>${opts}</select></td>
    </tr>`;
  }).join('');
  if(linhas.length>600) $('tbody').innerHTML += `<tr><td colspan="10" class="muted">Exibindo 600 itens do filtro — a exportação inclui todos.</td></tr>`;
  $('tbody').querySelectorAll('select.mini').forEach(s=>s.onchange=e=>corrigir(+e.target.dataset.i, e.target.value));
}

/* correção manual + replicação (mesmo NCM + mesma descrição, e mesma regra de enquadramento) */
async function corrigir(i, ct){
  if(!ct) return;
  const alvo=ITENS.find(x=>x.i===i); if(!alvo) return;
  const m=META.get(ct)||{};
  const aplica=(it,origem)=>{ it.ct=ct; it.cstTrib=m.cst||it.cstTrib; it.ctDesc=m.descricao||''; it.red=m.reducao||'';
    it.status='mem'; it.porMemoria=USER; it.origem=origem; };
  aplica(alvo,'manual');
  const regraAlvo=alvo.regra, dA=norm(alvo.desc);
  let repl=0;
  const grava=[];
  ITENS.forEach(it=>{
    if(it===alvo) return;
    const mesmoProduto = it.ncm===alvo.ncm && norm(it.desc)===dA;
    const mesmaRegra   = regraAlvo!=='—' && it.regra===regraAlvo && it.status!=='mem';
    if(mesmoProduto||mesmaRegra){ aplica(it,'replicado'); repl++; }
  });
  [alvo,...ITENS.filter(x=>x.origem==='replicado')].forEach(it=>grava.push({
    cliente_id: CLIENTE? CLIENTE.id : null, ncm: it.ncm, descricao_norm: norm(it.desc),
    campo:'cclasstrib', valor: ct, usuario: USER, origem: it.origem||'manual', fundamento_ref: it.regra
  }));
  kpis(); tabela();
  const {error} = await sb.from('memoria_correcao').upsert(grava, {onConflict:'cliente_id,ncm,descricao_norm,campo'});
  toast(error ? 'Correção aplicada na tela, mas não gravou no banco: '+error.message
              : `Correção <b>${ct}</b> gravada${repl?` e replicada em <b>${repl}</b> itens`:''}. Vale para as próximas planilhas.`);
  carregarMemoria();
}

/* ============================ EXPORTAÇÃO (preserva formatação) ============================ */
const colL = n => { let s=''; n++; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-1-m)/26; } return s; };
const colI = ref => { let n=0; for(const ch of ref.replace(/\d+/g,'')) n=n*26+(ch.charCodeAt(0)-64); return n-1; };

function destinos(){
  // grava sempre nas colunas mapeadas; cria no fim as que o cliente não tem
  let prox = HEADERS.length; const d={}; const novas=[];
  const pede = (chave, titulo)=>{
    if(MAPA[chave]!=='' && MAPA[chave]!==undefined) return +MAPA[chave];
    const i=prox++; novas.push([i,titulo]); return i;
  };
  d.ncm   = (MAPA.ncm!==''? +MAPA.ncm : pede('ncm','NCM'));
  d.cst   = pede('cst','CST/CSOSN ICMS');
  d.cfopS = pede('cfopS','CFOP SAÍDA');
  d.cfopE = pede('cfopE','CFOP ENTRADA');
  d.ctCbs = pede('ctCbs','CLASSTRIB CBS');
  d.dsCbs = pede('dsCbs','DESCRIÇÃO CLASSTRIB CBS');
  d.cstCbs= pede('cstCbs','CST CBS');
  d.ctIbs = pede('ctIbs','CLASSTRIB IBS');
  d.dsIbs = pede('dsIbs','DESCRIÇÃO CLASSTRIB IBS');
  d.cstIbs= pede('cstIbs','CST IBS');
  return {d, novas};
}

function indexar(sheetData){
  const rows=sheetData.getElementsByTagName('row'), byRow=new Map(), nums=[];
  for(let k=0;k<rows.length;k++){ const rn=+(rows[k].getAttribute('r')||(k+1)); byRow.set(rn,{el:rows[k],cells:null}); nums.push(rn); }
  return {byRow,nums};
}
function gravar(doc, sheetData, idx, linha, col, texto){
  if(texto===undefined||texto===null||texto==='') return;
  const NS=doc.documentElement.namespaceURI, ref=colL(col)+linha;
  let e=idx.byRow.get(linha);
  if(!e){ const row=doc.createElementNS(NS,'row'); row.setAttribute('r',String(linha));
    let before=null; for(const rn of idx.nums){ if(rn>linha){ before=idx.byRow.get(rn).el; break; } }
    sheetData.insertBefore(row,before); e={el:row,cells:new Map()}; idx.byRow.set(linha,e); idx.nums.push(linha); idx.nums.sort((a,b)=>a-b); }
  if(!e.cells){ e.cells=new Map(); const cs=e.el.getElementsByTagName('c');
    for(let k=0;k<cs.length;k++) e.cells.set(colI(cs[k].getAttribute('r')||''), cs[k]); }
  let cell=e.cells.get(col);
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
      let n=0;
      for(const it of ITENS){
        const L=HR+2+it.i;
        gravar(doc,sd,idx,L,d.ncm,   it.ncm);
        gravar(doc,sd,idx,L,d.cst,   it.cst);
        gravar(doc,sd,idx,L,d.cfopS, it.cfopS);
        gravar(doc,sd,idx,L,d.cfopE, it.cfopE);
        gravar(doc,sd,idx,L,d.ctCbs, it.ct);
        gravar(doc,sd,idx,L,d.dsCbs, it.ctDesc);
        gravar(doc,sd,idx,L,d.cstCbs,it.cstTrib);
        gravar(doc,sd,idx,L,d.ctIbs, it.ct);
        gravar(doc,sd,idx,L,d.dsIbs, it.ctDesc);
        gravar(doc,sd,idx,L,d.cstIbs,it.cstTrib);
        if(++n%800===0) await new Promise(r=>setTimeout(r,0));
      }
      const dim=doc.getElementsByTagName('dimension')[0];
      if(dim){ const m=(dim.getAttribute('ref')||'').match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if(m){ const max=Math.max(colI(m[3]), ...Object.values(d)); dim.setAttribute('ref', m[1]+m[2]+':'+colL(max)+m[4]); } }
      zip.file(path, new XMLSerializer().serializeToString(doc));
      baixar(await zip.generateAsync({type:'blob'}), RAWNAME.replace(/\.(xlsx|xlsm)$/i,'')+'_preenchida.xlsx');
      toast(`Planilha exportada com <b>${ITENS.length}</b> itens preenchidos, mantendo a formatação original.`);
      return;
    }catch(err){ console.warn(err); toast('Não consegui preservar a formatação — exportando em formato simples.'); }
  }
  const aoa=XLSX.utils.sheet_to_json(WB.Sheets[SHEET],{header:1,defval:''});
  const {d,novas}=destinos();
  novas.forEach(([c,t])=>{ aoa[HR][c]=t; });
  ITENS.forEach(it=>{ const row=aoa[HR+1+it.i]; if(!row) return;
    while(row.length<=Math.max(...Object.values(d))) row.push('');
    row[d.ncm]=it.ncm; row[d.cst]=it.cst; row[d.cfopS]=it.cfopS; row[d.cfopE]=it.cfopE;
    row[d.ctCbs]=it.ct; row[d.dsCbs]=it.ctDesc; row[d.cstCbs]=it.cstTrib;
    row[d.ctIbs]=it.ct; row[d.dsIbs]=it.ctDesc; row[d.cstIbs]=it.cstTrib; });
  const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(aoa), SHEET);
  baixar(new Blob([XLSX.write(wb2,{bookType:'xlsx',type:'array'})],{type:'application/octet-stream'}),
         (RAWNAME.replace(/\.[^.]+$/,'')||'planilha')+'_preenchida.xlsx');
  toast(`Planilha exportada com <b>${ITENS.length}</b> itens preenchidos.`);
};

$('btnCsv').onclick=()=>{
  const h=['Linha','Produto','NCM original','NCM','Situação','CSOSN/CST','CFOP saída','CFOP entrada','cClassTrib','CST IBS/CBS','Redução','Observação'];
  const l=[h.join(';')].concat(ITENS.map(i=>[i.i+2+HR,`"${(i.desc||'').replace(/"/g,'""')}"`,i.ncmOrig,i.ncm,
    SIT[i.status][1],i.cst,i.cfopS,i.cfopE,i.ct,i.cstTrib,i.red||'',
    `"${[i.ncmMsg,i.nota,i.notaFiscal].filter(Boolean).join(' | ').replace(/"/g,'""')}"`].join(';')));
  baixar(new Blob(['﻿'+l.join('\n')],{type:'text/csv;charset=utf-8'}),'relatorio_mix_fiscal.csv');
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
$('btnRecarregar').onclick=()=>carregarAtos();
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

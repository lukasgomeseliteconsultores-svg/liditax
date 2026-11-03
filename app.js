/* ============================================================
   MIX FISCAL · ELITE
   Front-end do preenchimento de cadastro fiscal de produtos.
   Banco: Supabase (projeto mix-fiscal-elite, região sa-east-1)
   ============================================================ */
const SB_URL  = 'https://mxsznvkksqeogkkgoylo.supabase.co';
const SB_KEY  = 'sb_publishable_U4WfRm7NFfhY86yLHAjPZw_9mFW5Es0';
// O acesso não depende mais do domínio do e-mail: quem libera é o administrador
// do portal, na tela "Acessos". O banco valida a aprovação por RLS.
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
let ST=[];   // substituição tributária da UF do cliente (Anexo 007 do RICMS/RN)
let WB=null, RAW=null, RAWNAME='', SHEET='', HR=0, HEADERS=[], MAPA={}, ITENS=[], FILTRO='all';
let SELECAO=new Set();   // chaves de itens marcados para edição em lote

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
  if(b.dataset.tela==='atualizacoes') carregarAtos();
  if(b.dataset.tela==='base'){ carregarMemoria(); kpisBase(); }
  if(b.dataset.tela==='acessos') carregarAcessos();
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
  await carregarST();
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

async function carregarST(){
  const uf = (CLIENTE && CLIENTE.uf) || 'RN';
  const {data} = await sb.from('st_uf').select('cest,ncm,descricao,segmento,fundamento').eq('uf',uf).limit(5000);
  ST = (data||[]).sort((a,b)=>b.ncm.length-a.ncm.length);   // mais específico primeiro
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
function fiscalPorRegime(item, cliente){
  const simples = cliente && (cliente.regime==='simples' || cliente.opcao_simples);
  // o anexo oficial da UF é a autoridade; o CEST digitado na planilha é só pista
  // e vale apenas quando o anexo daquela UF ainda não foi carregado
  const temST = ST.length
    ? !!item.st
    : (!!item.cestOrig || /^(500|60|10|70)/.test(String(item.cstOrig||'')));
  const out = {};
  if(simples){
    out.cst   = temST ? '500' : '102';
    out.cfopS = temST ? '5405' : '5102';
    out.cfopE = temST ? '1403' : '1102';
    out.nota  = 'Simples Nacional: CSOSN '+out.cst+(temST?' (mercadoria com ST)':' (sem ST)')
              + (item.st? ' · '+item.st.fundamento : '');
  } else {
    out.cst   = temST ? '060' : '000';
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
    SHEET = WB.SheetNames[0];
    const aoa=XLSX.utils.sheet_to_json(WB.Sheets[SHEET],{header:1,defval:''});
    HR=0; for(let i=0;i<Math.min(aoa.length,10);i++){ if((aoa[i]||[]).filter(c=>typeof c==='string'&&c.trim()).length>=3){HR=i;break;} }
    HEADERS=(aoa[HR]||[]).map((h,i)=>(h+'').trim()||('Coluna '+XLSX.utils.encode_col(i)));
    await montarMapa();
    $('p2').hidden=false; $('p2').open=true; $('p1').open=false;
    $('resumoArq').textContent = RAWNAME;
    $('infoArq').textContent = `${aoa.length-HR-1} linhas · ${HEADERS.length} colunas · aba "${SHEET}"`;
    $('mapOrigem').textContent = CLIENTE && MAPA.__salvo ? '— mapeamento salvo deste cliente' : '— detectado automaticamente';
  };
  rd.readAsArrayBuffer(f);
}

const CAMPOS = [
  ['desc',  'Descrição do produto', ['produto','descricao','descrição','item','mercadoria']],
  ['ncm',   'NCM',                  ['ncm']],
  ['cest',  'CEST',                 ['cest']],
  ['valor', 'Valor de venda',       ['valor','preco','preço','venda']],
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
$('selCliente').onchange = async e=>{
  CLIENTE = CLIENTES.find(c=>c.id===e.target.value)||null;
  await carregarST();
  if(CLIENTE) toast(`Cliente ${esc(CLIENTE.uf)} · ${ST.length} itens de substituição tributária carregados do anexo da UF.`);
};

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
    } else if(item.cestOrig){
      item.cestDivergente = true;
      item.nota = (item.nota?item.nota+' · ':'') + 'Planilha traz CEST, mas o NCM não consta no anexo de ST da UF';
    }
    const a = classificarIbsCbs(item.ncm, item.desc);
    item.ct=a.ct; item.cstTrib=a.cst; item.ctDesc=a.desc; item.red=a.red; item.regra=a.regra;
    item.nota=a.nota||''; item.confIbs=a.conf;
    const f = fiscalPorRegime(item, CLIENTE);
    item.cst = item.cstOrig || f.cst;  item.cstSug = !item.cstOrig;
    item.cfopS = item.cfopSOrig || f.cfopS; item.cfopSSug = !item.cfopSOrig;
    item.cfopE = f.cfopE; item.cfopESug = true;   // vazio em toda a planilha: sempre sugestão
    item.notaFiscal = f.nota;
    item.status = item.ncmStatus==='err' ? 'err'
                : (item.confIbs==='rev' || item.cstSug || item.ncmStatus==='rev'
                   || item.cestDivergente || (item.st && !item.st.confirmado)) ? 'rev' : 'ok';
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

function chaveItem(it){ return it.sheet? it.sheet+'||'+it.i : String(it.i); }

function tabela(){
  const q=norm($('busca').value);
  const linhas=ITENS.filter(i=>(FILTRO==='all'||i.status===FILTRO) &&
    (!q || norm(i.desc).includes(q) || i.ncm.includes(q) || (i.cest||'').includes(q)));
  $('infoFiltro').textContent=`${linhas.length} de ${ITENS.length} itens`;
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
      <td class="mono ${it.cstSug?'fill':''}">${esc(it.cst)}</td>
      <td class="mono ${it.cfopSSug?'fill':''}">${esc(it.cfopS)} · ${esc(it.cfopE)}</td>
      <td class="mono fill">${esc(it.ct)}
        <div class="muted">${esc((it.ctDesc||'').slice(0,34))}</div></td>
      <td><span class="chip ${cl}">${rot}</span>${it.porMemoria?`<div class="muted">${esc((it.porMemoria||'').split('@')[0])}</div>`:''}</td>
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
const CAMPO_ITEM = {cclasstrib:'ct', cest:'cest', cst:'cst', cfop_saida:'cfopS', cfop_entrada:'cfopE'};
async function aplicarEmLote(campo, valor, chaves){
  const alvos = ITENS.filter(i=>chaves.has(chaveItem(i)));
  if(!alvos.length || !valor) return 0;
  const prop = CAMPO_ITEM[campo];
  const registros=[];
  alvos.forEach(it=>{
    it[prop]=valor;
    if(campo==='cclasstrib'){ const m=META.get(valor)||{}; it.cstTrib=m.cst||it.cstTrib; it.ctDesc=m.descricao||''; it.red=m.reducao||''; }
    if(campo==='cst') it.cstSug=false;
    if(campo==='cfop_saida') it.cfopSSug=false;
    if(campo==='cfop_entrada') it.cfopESug=false;
    it.status='mem'; it.porMemoria=USER; it.edited=true;
    registros.push({cliente_id: CLIENTE? CLIENTE.id : null, ncm:it.ncm, descricao_norm:norm(it.desc),
                    campo, valor, usuario:USER, origem:'manual'});
  });
  const {error} = await sb.from('memoria_correcao').upsert(registros, {onConflict:'cliente_id,ncm,descricao_norm,campo'});
  if(error) toast('Aplicado na tela, mas não gravou na memória: '+error.message);
  kpis(); tabela(); carregarMemoria();
  return alvos.length;
}
$('btnLote').onclick=async()=>{
  const campo=$('loteCampo').value, valor=$('loteValor').value.trim();
  if(!valor){ toast('Informe o valor a aplicar.'); return; }
  const n=await aplicarEmLote(campo, valor, new Set(SELECAO));
  $('loteValor').value='';
  toast(`<b>${n}</b> itens atualizados e gravados na memória da equipe.`);
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
  $('pnLinha').textContent=`linha ${it.i+2+HR}${it.sheet?' · aba '+it.sheet:''}${it.valor?' · valor '+it.valor.toFixed(2):''}`;
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

  let total=0;
  if(ESCOLHA.ncm && ESCOLHA.ncm!==it.ncm){
    const alvos=ITENS.filter(x=>chaves.has(chaveItem(x)));
    alvos.forEach(x=>{ x.ncm=ESCOLHA.ncm; x.ncmStatus='mem'; x.ncmMsg='NCM definido no painel de revisão';
      x.st=consultarST(x.ncm,x.desc); x.cest=x.st?x.st.cest:''; x.status='mem'; x.porMemoria=USER; });
    await sb.from('memoria_correcao').upsert(alvos.map(x=>({cliente_id:CLIENTE?CLIENTE.id:null, ncm:x.ncm,
      descricao_norm:norm(x.desc), campo:'ncm', valor:ESCOLHA.ncm, usuario:USER, origem:'manual'})),
      {onConflict:'cliente_id,ncm,descricao_norm,campo'});
    await carregarTextosOficiais(); total=alvos.length;
  }
  if(ESCOLHA.cest) total=Math.max(total, await aplicarEmLote('cest', ESCOLHA.cest, chaves));
  if($('pnCt').value!==it.ct) total=Math.max(total, await aplicarEmLote('cclasstrib', $('pnCt').value, chaves));
  if($('pnCst').value!==it.cst) total=Math.max(total, await aplicarEmLote('cst', $('pnCst').value.trim(), chaves));
  if($('pnCfopS').value!==it.cfopS) total=Math.max(total, await aplicarEmLote('cfop_saida', $('pnCfopS').value.trim(), chaves));
  if($('pnCfopE').value!==it.cfopE) total=Math.max(total, await aplicarEmLote('cfop_entrada', $('pnCfopE').value.trim(), chaves));
  fecharPainel(); kpis(); tabela();
  toast(total? `<b>${total}</b> item(ns) atualizado(s) e gravados na memória.` : 'Nada foi alterado.');
};

/* correção manual + replicação (mesmo NCM + mesma descrição, e mesma regra de enquadramento) */
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

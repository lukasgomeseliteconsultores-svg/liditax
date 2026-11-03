/**
 * import-rn — carrega os anexos do RICMS/RN no banco, buscando os arquivos
 * publicados no próprio site (que é público). Roda no Supabase, sem humano.
 *
 *  rn-st.json         → substituição tributária (Anexo 007): CEST, NCM, MVA
 *  rn-beneficios.json → cesta básica 7% e artigos de isenção e redução
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE = "https://mix-fiscal-elite.netlify.app/dados/";

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const inicio = Date.now();
  const resumo: Record<string, unknown> = {};

  const baixar = async (arquivo: string) => {
    const r = await fetch(SITE + arquivo, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(arquivo + " respondeu " + r.status);
    return await r.json();
  };

  try {
    // ---------- substituição tributária ----------
    const st = await baixar("rn-st.json");
    const itens = (st.itens ?? []).map((i: any) => ({
      uf: "RN", cest: i.cest, ncm: i.ncm, descricao: i.descricao, segmento: i.segmento,
      fundamento: st.fonte, vigencia_ini: "2022-08-19",
    }));
    let stGravados = 0;
    for (let k = 0; k < itens.length; k += 500) {
      const { error } = await sb.from("st_uf").upsert(itens.slice(k, k + 500),
        { onConflict: "uf,cest,ncm,vigencia_ini" });
      if (!error) stGravados += Math.min(500, itens.length - k);
    }
    resumo.st = stGravados;

    await sb.from("st_mva").delete().eq("uf", "RN");
    const mva = (st.mva ?? []).map((m: any) => ({ uf: "RN", ...m, fundamento: st.fonte }));
    for (let k = 0; k < mva.length; k += 500) await sb.from("st_mva").insert(mva.slice(k, k + 500));
    resumo.mva = mva.length;

    // ---------- benefícios ----------
    const ben = await baixar("rn-beneficios.json");
    const normas = (ben.normas ?? []).map((n: any) => ({
      uf: "RN", tipo: n.tipo, artigo: n.artigo, texto: n.texto, ncms: n.ncms, fundamento: ben.fonte,
    }));
    let normasGravadas = 0;
    for (let k = 0; k < normas.length; k += 300) {
      const { error } = await sb.from("norma_uf").upsert(normas.slice(k, k + 300),
        { onConflict: "uf,tipo,artigo" });
      if (!error) normasGravadas += Math.min(300, normas.length - k);
    }
    resumo.normas = normasGravadas;

    await sb.from("sync_log").insert({ rotina: "import-rn", situacao: "ok", detalhe: resumo,
      duracao_ms: Date.now() - inicio });
    return new Response(JSON.stringify({ ok: true, ...resumo }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    await sb.from("sync_log").insert({ rotina: "import-rn", situacao: "falhou",
      detalhe: { erro: String(e), ...resumo }, duracao_ms: Date.now() - inicio });
    return new Response(JSON.stringify({ ok: false, erro: String(e) }), { headers: { "Content-Type": "application/json" } });
  }
});

// Vigilância por hash das fontes oficiais (trilhos federal e estadual).
// Só detecta e avisa: quando a assinatura de uma fonte muda, grava um registro em
// atualizacao_legislativa. Não lê nem interpreta o conteúdo — a extração continua
// sendo feita no chat, a partir do documento enviado, e a regra só vale depois da curadoria.
import { createClient } from "jsr:@supabase/supabase-js@2";

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// só para exibição no aviso (não entra no hash, para não gerar alerta falso)
const legivel = (t: string) =>
  t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"');

const semTags = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// assinatura "links": a lista ordenada de links (endereço + texto) da página.
// Muda quando um arquivo novo é publicado ou um existente é renomeado/substituído,
// e ignora relógio, banners e contadores que mudam a cada acesso.
function assinaturaLinks(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1].trim();
    if (/^(javascript:|mailto:)/i.test(href)) continue;
    out.add(href + " | " + semTags(m[2]).slice(0, 160));
  }
  return [...out].sort();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("use POST", { status: 405 });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: fontes, error } = await sb.from("fonte_vigiada").select("*").eq("ativo", true);
  if (error) return Response.json({ erro: error.message }, { status: 500 });

  const agora = new Date();
  const hoje = agora.toISOString().slice(0, 10);
  const resultado: Record<string, unknown>[] = [];

  for (const f of fontes ?? []) {
    try {
      const r = await fetch(f.url, {
        redirect: "follow",
        headers: { "User-Agent": "MIX-Fiscal-ELITE/vigia (verificacao de atualizacao de legislacao)" },
        signal: AbortSignal.timeout(45000),
      });
      if (!r.ok) {
        await sb.from("fonte_vigiada").update({ verificado_em: agora.toISOString(), ultimo_status: r.status, erro: "HTTP " + r.status }).eq("id", f.id);
        resultado.push({ fonte: f.nome, status: r.status, alterada: false });
        continue;
      }
      const bruto = await r.arrayBuffer();
      const tipo = r.headers.get("content-type") ?? "";
      let links: string[] = [];
      let base: Uint8Array = new Uint8Array(bruto);
      if (tipo.includes("html")) {
        const html = new TextDecoder("utf-8").decode(bruto);
        if (f.modo === "links") {
          links = assinaturaLinks(html);
          base = new TextEncoder().encode(links.join("\n"));
        } else {
          base = new TextEncoder().encode(semTags(html));
        }
      }
      const hash = hex(await crypto.subtle.digest("SHA-256", base));
      const mudou = !!f.hash && f.hash !== hash;
      const anteriores: string[] = f.links ?? [];
      const novos = mudou && f.modo === "links" ? links.filter((l) => !anteriores.includes(l)) : [];
      const saiu = mudou && f.modo === "links" ? anteriores.filter((l) => !links.includes(l)) : [];

      await sb.from("fonte_vigiada").update({
        hash,
        links: f.modo === "links" ? links.slice(0, 3000) : null,
        verificado_em: agora.toISOString(),
        ultimo_status: r.status,
        erro: null,
        ...(mudou ? { alterado_em: agora.toISOString() } : {}),
      }).eq("id", f.id);

      if (mudou) {
        const lista = (v: string[]) => v.slice(0, 15).map((l) => "• " + legivel(l.split(" | ").reverse().join(" — "))).join("\n");
        const ementa = [
          "A fonte oficial mudou desde a última verificação (hash " + hash.slice(0, 12) + ").",
          novos.length ? "Novos itens publicados:\n" + lista(novos) : "",
          saiu.length ? "Itens que saíram:\n" + lista(saiu) : "",
          "Próximo passo: baixar o documento, enviar no chat para extração e aprovar as regras na Curadoria.",
        ].filter(Boolean).join("\n\n");
        await sb.from("atualizacao_legislativa").insert({
          fonte: f.nome,
          esfera: f.trilho === "federal" ? "federal" : "estadual",
          uf: f.uf,
          ato: "Alteração detectada em " + hoje.split("-").reverse().join("/") + " (" + hash.slice(0, 8) + ")",
          ementa,
          publicado_em: hoje,
          impacto: f.impacto,
          url: f.url,
          situacao: "novo",
        });
      }
      resultado.push({ fonte: f.nome, status: r.status, alterada: mudou, primeira_leitura: !f.hash, novos: novos.length });
    } catch (e) {
      await sb.from("fonte_vigiada").update({ verificado_em: agora.toISOString(), erro: String(e).slice(0, 300) }).eq("id", f.id);
      resultado.push({ fonte: f.nome, erro: String(e).slice(0, 200) });
    }
  }
  return Response.json({ verificadas: resultado.length, alteradas: resultado.filter((x) => x.alterada).length, resultado });
});

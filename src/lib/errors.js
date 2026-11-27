// Registro de erros inesperados para o super administrador. Melhor esforço:
// uma falha ao registrar nunca afeta a resposta ao usuário.

// Mascara números longos (telefones, por exemplo) e limita o tamanho.
export function safePath(path) {
  return String(path).replace(/\d{6,}/g, ":n").slice(0, 200);
}

export async function recordError(env, request, error) {
  try {
    const path = safePath(new URL(request.url).pathname);
    const message = String(error?.message || error).slice(0, 500);
    const stack = String(error?.stack || "").split("\n").slice(0, 8).join("\n").slice(0, 2000);
    await env.DB.prepare("INSERT INTO error_log(method,path,message,stack) VALUES(?,?,?,?)").bind(request.method, path, message, stack).run();
    if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM error_log WHERE created_at < datetime('now','-30 days')").run();
  } catch {
    /* o banco pode ser justamente a causa do erro */
  }
}

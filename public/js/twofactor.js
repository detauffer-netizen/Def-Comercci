// Interface da verificação em duas etapas, usada pelo painel e pela administração.
import { api, h, toast } from "./common.js";

export function mountTwoFactor(container, base = "/api/account/2fa") {
  const render = async () => {
    let status;
    try {
      status = await api(base);
    } catch (error) {
      container.replaceChildren(h("p", { class: "form-error", text: error.message }));
      return;
    }
    container.replaceChildren(status.enabled ? enabledView(status) : disabledView());
  };

  function disabledView() {
    const password = h("input", { type: "password", autocomplete: "current-password" });
    return h("div", { class: "tfa" },
      h("p", { class: "muted", text: "Proteja sua conta com um código do aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy...) além da senha." }),
      h("label", { class: "field" }, h("span", { text: "Confirme sua senha para começar" }), password),
      h("button", { class: "btn btn-blue", type: "button", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const setup = await api(`${base}/setup`, { method: "POST", body: { password: password.value } });
          container.replaceChildren(setupView(setup));
        } catch (error) {
          toast(error.message, { error: true });
          e.target.disabled = false;
        }
      } }, "Ativar verificação em duas etapas"));
  }

  function setupView(setup) {
    const input = h("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "000000" });
    return h("div", { class: "tfa" },
      h("ol", { class: "tfa-steps" },
        h("li", {}, "No celular, abra o aplicativo autenticador e ", h("a", { href: setup.otpauth, text: "toque aqui para adicionar a conta" }), ", ou digite a chave abaixo."),
        h("li", {}, "Digite o código de 6 dígitos que aparecer.")),
      h("code", { class: "tfa-secret", text: setup.secret.replace(/(.{4})/g, "$1 ").trim() }),
      h("label", { class: "field" }, h("span", { text: "Código do aplicativo" }), input),
      h("button", { class: "btn btn-blue", type: "button", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const done = await api(`${base}/enable`, { method: "POST", body: { code: input.value } });
          container.replaceChildren(recoveryView(done.recovery_codes));
          toast("Verificação em duas etapas ativada.");
        } catch (error) {
          toast(error.message, { error: true });
          e.target.disabled = false;
        }
      } }, "Confirmar e ativar"));
  }

  function recoveryView(codes) {
    return h("div", { class: "tfa" },
      h("p", { class: "tfa-on", text: "Verificação em duas etapas ativa." }),
      h("p", { text: "Guarde estes códigos de recuperação em local seguro. Cada um funciona uma única vez, caso você perca o celular. Eles não serão mostrados de novo." }),
      h("ul", { class: "tfa-codes" }, ...codes.map((c) => h("li", {}, h("code", { text: c })))),
      h("button", { class: "btn btn-ghost", type: "button", onclick: async () => {
        try {
          await navigator.clipboard.writeText(codes.join("\n"));
          toast("Códigos copiados.");
        } catch {
          toast("Não foi possível copiar; anote os códigos.", { error: true });
        }
      } }, "Copiar códigos"),
      h("button", { class: "btn btn-ghost", type: "button", onclick: render }, "Concluído"));
  }

  function enabledView(status) {
    const password = h("input", { type: "password", autocomplete: "current-password" });
    const code = h("input", { inputmode: "numeric", autocomplete: "one-time-code" });
    return h("div", { class: "tfa" },
      h("p", { class: "tfa-on", text: "Verificação em duas etapas ativa." }),
      h("p", { class: "muted", text: `${status.recovery_codes_left} código(s) de recuperação disponível(is).` }),
      h("details", {},
        h("summary", { text: "Desativar" }),
        h("label", { class: "field" }, h("span", { text: "Sua senha" }), password),
        h("label", { class: "field" }, h("span", { text: "Código do aplicativo" }), code),
        h("button", { class: "btn btn-danger", type: "button", onclick: async (e) => {
          if (!confirm("Desativar a verificação em duas etapas? Sua conta ficará protegida só pela senha.")) return;
          e.currentTarget.disabled = true;
          try {
            await api(`${base}/disable`, { method: "POST", body: { password: password.value, code: code.value } });
            toast("Verificação em duas etapas desativada.");
            render();
          } catch (error) {
            toast(error.message, { error: true });
            e.target.disabled = false;
          }
        } }, "Desativar verificação")));
  }

  render();
}

const norwegian = require("./locales/nb.json");

// English UI copy is the key and fallback, so both languages share the same views.
function translator(language) {
  return (key, values = {}) => {
    const message = language === "nb" && Object.hasOwn(norwegian, key)
      ? norwegian[key]
      : key;
    return String(message ?? "").replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    );
  };
}

function languageFromCookie(header = "") {
  const value = header.split(";").map((part) => part.trim())
    .find((part) => part.startsWith("chorequest_language="))?.split("=")[1];
  return value === "nb" ? "nb" : "en";
}

function languageReturnTo(value) {
  if (typeof value !== "string" || /[\\\r\n]/.test(value)) return "/dashboard";
  // Only return to pages that can be safely loaded with GET; never external URLs.
  return /^\/(?:dashboard|login)(?:[?#]|$)/.test(value) ? value : "/dashboard";
}

module.exports = { translator, languageFromCookie, languageReturnTo };

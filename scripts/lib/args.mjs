/**
 * Copyright 2026 Sean Koji
 * SPDX-License-Identifier: Apache-2.0
 */
export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const rawKey = token.slice(2, separator === -1 ? undefined : separator);
      const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (
          nextValue === undefined ||
          (inlineValue === undefined &&
            isRecognizedOptionToken(
              nextValue,
              valueOptions,
              booleanOptions,
              aliasMap
            ))
        ) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (
        nextValue === undefined ||
        isRecognizedOptionToken(
          nextValue,
          valueOptions,
          booleanOptions,
          aliasMap
        )
      ) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

function isRecognizedOptionToken(token, valueOptions, booleanOptions, aliasMap) {
  if (!token || token === "-" || token === "--" || !token.startsWith("-")) {
    return token === "--";
  }

  if (token.startsWith("--")) {
    const [rawKey] = token.slice(2).split("=", 2);
    const key = aliasMap[rawKey] ?? rawKey;
    return valueOptions.has(key) || booleanOptions.has(key);
  }

  const shortKey = token.slice(1);
  const key = aliasMap[shortKey] ?? shortKey;
  return valueOptions.has(key) || booleanOptions.has(key);
}

// A quote opened as an option value (`--cwd '...'`, `-C '...'`, `--cwd='...'`)
// must close cleanly; free-text apostrophes elsewhere stay literal.
function isOptionShaped(token) {
  return /^-[^-\s]|^--[^\s=]/.test(token);
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let quoteIsValue = false;
  let closedValueQuote = false;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        closedValueQuote ||= quoteIsValue && quote === "'";
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\"" || (character === "'" && (!current || current.endsWith("=")))) {
      quote = character;
      quoteIsValue = current
        ? isOptionShaped(current)
        : tokens.length > 0 && isOptionShaped(tokens[tokens.length - 1]);
      continue;
    }

    if (character === "'") {
      // `--cwd 'C:\it's'` closes the value at `it`; reject rather than mangle it.
      if (closedValueQuote) throw new Error("Unterminated quote in raw argument string");
      current += character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      closedValueQuote = false;
      continue;
    }

    current += character;
  }

  if (quote) {
    if (quoteIsValue) throw new Error("Unterminated quote in raw argument string");
    return [raw];
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

// A deliberately small, strict XML reader for Blockly workspace exports.
//
// Why not a general XML library: the input is uploaded by a person, and the only XML features a
// Blockly export needs are elements, attributes and text. Everything else that makes XML parsers a
// security surface — DOCTYPE, entity declarations, external entities, CDATA, processing
// instructions other than the <?xml ?> header — is simply REFUSED here, so there is nothing to
// expand, fetch or recurse into. Size, depth and node counts are capped before any work is done.
//
// The only character references accepted are the five predefined entities (&amp; &lt; &gt; &quot;
// &apos;) and numeric ones (&#10; &#x0A;). Any other &name; is an error, never expanded.

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text directly inside this element (entities decoded). */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlError";
  }
}

export const XML_LIMITS = { maxBytes: 200 * 1024, maxDepth: 200, maxElements: 30_000 } as const;

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_m, ref: string) => {
    switch (ref) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = ref.startsWith("#x") ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError("Invalid character reference");
        return String.fromCodePoint(code);
      }
    }
  });
}

function assertNoStrayEntities(decodedSource: string, original: string) {
  // After decoding the allowed references, any remaining "&" in the ORIGINAL that wasn't part of
  // one means an unknown entity — refuse rather than pass it through.
  const withoutAllowed = original.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, "");
  if (withoutAllowed.includes("&")) throw new XmlError("The file uses an XML entity that isn't allowed");
  void decodedSource;
}

export function parseXml(source: string): XmlElement {
  if (typeof source !== "string") throw new XmlError("No XML was provided");
  if (Buffer.byteLength(source, "utf8") > XML_LIMITS.maxBytes) throw new XmlError(`The file is larger than ${XML_LIMITS.maxBytes / 1024} KB`);
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(source)) throw new XmlError("DOCTYPE, entity and CDATA sections aren't allowed in a Deriv Bot file");

  let i = 0;
  const n = source.length;
  if (source.charCodeAt(0) === 0xfeff) i = 1; // BOM
  let elements = 0;

  const skipWs = () => {
    while (i < n && /\s/.test(source[i]!)) i++;
  };

  const readName = (): string => {
    if (i >= n || !NAME_START.test(source[i]!)) throw new XmlError(`Unexpected character at position ${i}`);
    const start = i;
    while (i < n && NAME_CHAR.test(source[i]!)) i++;
    return source.slice(start, i);
  };

  // Skips <?xml …?> and comments between nodes. Returns true if something was skipped.
  const skipMisc = (): boolean => {
    if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) throw new XmlError("Unterminated <?…?>");
      if (!/^<\?xml[\s?]/i.test(source.slice(i, i + 6))) throw new XmlError("Processing instructions aren't allowed");
      i = end + 2;
      return true;
    }
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) throw new XmlError("Unterminated comment");
      i = end + 3;
      return true;
    }
    return false;
  };

  const parseElement = (depth: number): XmlElement => {
    if (depth > XML_LIMITS.maxDepth) throw new XmlError("The file is nested too deeply");
    if (++elements > XML_LIMITS.maxElements) throw new XmlError("The file has too many elements");
    if (source[i] !== "<") throw new XmlError(`Expected an element at position ${i}`);
    i++;
    const name = readName();
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWs();
      if (i >= n) throw new XmlError("Unexpected end of file");
      if (source[i] === "/" || source[i] === ">") break;
      const attr = readName();
      skipWs();
      if (source[i] !== "=") throw new XmlError(`Attribute "${attr}" has no value`);
      i++;
      skipWs();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") throw new XmlError(`Attribute "${attr}" must be quoted`);
      const end = source.indexOf(quote, i + 1);
      if (end < 0) throw new XmlError("Unterminated attribute value");
      const raw = source.slice(i + 1, end);
      if (raw.includes("<")) throw new XmlError("A '<' isn't allowed inside an attribute value");
      assertNoStrayEntities("", raw);
      if (Object.prototype.hasOwnProperty.call(attrs, attr)) throw new XmlError(`Attribute "${attr}" appears twice`);
      attrs[attr] = decodeEntities(raw);
      i = end + 1;
    }
    const el: XmlElement = { name, attrs, children: [], text: "" };
    if (source[i] === "/") {
      if (source[i + 1] !== ">") throw new XmlError("Malformed empty element");
      i += 2;
      return el;
    }
    i++; // '>'
    for (;;) {
      if (i >= n) throw new XmlError(`Element <${name}> was never closed`);
      if (source[i] === "<") {
        if (source.startsWith("</", i)) {
          i += 2;
          const closing = readName();
          skipWs();
          if (source[i] !== ">") throw new XmlError("Malformed closing tag");
          i++;
          if (closing !== name) throw new XmlError(`Closing tag </${closing}> doesn't match <${name}>`);
          return el;
        }
        if (skipMisc()) continue;
        if (source.startsWith("<!", i)) throw new XmlError("Unsupported <! section");
        el.children.push(parseElement(depth + 1));
      } else {
        const end = source.indexOf("<", i);
        const rawText = source.slice(i, end < 0 ? n : end);
        assertNoStrayEntities("", rawText);
        el.text += decodeEntities(rawText);
        i = end < 0 ? n : end;
      }
    }
  };

  while (i < n) {
    skipWs();
    if (!skipMisc()) break;
  }
  if (i >= n) throw new XmlError("The file is empty");
  const root = parseElement(0);
  for (;;) {
    skipWs();
    if (i >= n) break;
    if (!skipMisc()) throw new XmlError("There is extra content after the end of the file's root element");
  }
  return root;
}

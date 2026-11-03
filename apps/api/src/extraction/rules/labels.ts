/**
 * Label vocabularies. Deliberately broad (English plus common EU/South-Asian variants) and not
 * tuned to any single template; OCR-tolerant where cheap ("lnvoice", "N0").
 */

const I = '[Ii1l|]';

export const INVOICE_NUMBER_LABELS: RegExp[] = [
  new RegExp(`\\b(?:tax\\s+)?${I}nvoice\\s*(?:no\\.?|n[o0°]\\.?|number|num\\.?|nr\\.?|#|id|ref(?:erence)?(?:\\s+no\\.?)?)(?=[\\s:#.]|$)`, 'i'),
  /\binv\.?\s*(?:no\.?|#|number)(?=[\s:#.]|$)/i,
  /\b(?:bill|receipt|voucher|document|doc)\s*(?:no\.?|n[o0°]\.?|number|#)(?=[\s:#.]|$)/i,
  /\b(?:rechnungs?(?:nummer|-?nr\.?)|facture\s*n[o°]\.?|n[o°]\s*de\s*facture|factura\s*n[o°]\.?)/i,
  new RegExp(`^\\s*${I}nvoice\\s*:`, 'i'),
];

/** Labels that look like invoice-number labels but are something else. */
export const NOT_INVOICE_NUMBER = /\b(?:p\.?o\.?|purchase\s+order|order|customer|client|account|acct|vat|gst|tax\s+(?:id|no|reg)|reg(?:istration)?|challan|work\s+order|delivery|dispatch|ship(?:ping|ment)?|tracking|bin|tin|abn|gstin|pan|cin|iban|swift|sort\s+code|routing|phone|tel|fax|mushak|company|job|contract|serial|batch|lot)\b/i;

export const INVOICE_DATE_LABELS: RegExp[] = [
  new RegExp(`\\b(?:${I}nvoice|bill|issue|document|tax\\s+point|receipt)\\s*date\\b`, 'i'),
  /\bdate\s+of\s+(?:issue|invoice|supply)\b/i,
  /\b(?:dated|issued(?:\s+on)?|rechnungsdatum|date\s+de\s+facture)\b/i,
  /(?:^|\s{2,}|\|)\s*date\s*[:.]?(?=\s|$)/i,
];

export const NOT_INVOICE_DATE = /\b(?:due|delivery|deliver(?:ed)?|order|ship(?:ping|ped)?|dispatch|payment|service|supply\s+period|po|challan|expiry|exp|valid|print(?:ed)?|period|from|to|start|end)\b/i;

export const DUE_DATE_LABELS: RegExp[] = [
  /\b(?:payment\s+)?due\s*date\b/i,
  /\bpayment\s+due\b/i,
  /\b(?:date\s+due|due\s+(?:on|by)|pay(?:ment)?\s+by|payable\s+by|f(?:ä|ae)llig(?:keitsdatum)?)\b/i,
  /(?:^|\s{2,})\s*due\s*[:.]?(?=\s|$)/i,
];

export const CUSTOMER_LABELS: RegExp[] = [
  /\b(?:bill(?:ed)?\s*to|invoice(?:d)?\s*to|sold\s*to|charge\s*to)\b\s*:?/i,
  /\b(?:customer|client|buyer|purchaser|recipient|consignee|receiver|kunde)(?:\s+name)?\b(?!\s*(?:id|no|number|ref|reference|account|acct|code|#|vat|gst|tax|po|order|since))\s*:?/i,
  /^\s*(?:to|attn|attention)\s*:/i,
];

export const SUPPLIER_LABELS: RegExp[] = [
  /^\s*from\b\s*:?/i,
  /\b(?:supplier|vendor|seller|sold\s+by|issued\s+by|billed\s+by|service\s+provider|merchant|lieferant)\b(?!\s*(?:id|no|number|code|#|vat|gst|tax|ref))\s*:?/i,
];
/** Weaker evidence of the issuer (payment instructions); used only when the letterhead is unclear. */
export const SUPPLIER_WEAK_LABELS: RegExp[] = [
  /\b(?:make\s+(?:all\s+)?(?:checks?|cheques?|payments?)\s+payable\s+to|payable\s+to|remit(?:tance)?\s+to)\b\s*:?/i,
];

export const COMPANY_SUFFIX =
  /\b(?:ltd|limited|llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|plc|pvt|gmbh|ag|kg|sarl|s\.a|sa|bv|b\.v|nv|n\.v|pty|pte|llp|lp|oy|ab|srl|spa|sas|enterprises?|traders|trading|services|solutions|group|holdings|industries|hall|mart|store|stores|pharmacy|clinic|hospital|care|healthcare|nursing|supplies|supply|associates|partners|studio|agency|logistics|logistiek|technologies|systems)\b\.?/i;

export const DOC_TITLE = /^(?:tax\s+)?(?:invoice|bill|receipt|credit\s+note|debit\s+note|statement|quotation|proforma|cash\s+memo|mushak[-\s]?6\.3|rechnung|facture)\b/i;

export const CONTACT_LINE = /@|https?:|www\.|\b(?:tel|phone|fax|mob(?:ile)?|email|e-mail|web|website)\b|\+\d{2,}/i;
export const ID_LINE = /\b(?:vat|gst|abn|acn|bin|tin|ein|gstin|pan|cin|reg(?:istration)?|company\s+no|tax\s+(?:id|no)|iban|bic|swift|sort\s+code|routing|account)\b/i;
export const ADDRESS_HINT = /\b(?:street|st\.|road|rd\.?|avenue|ave|lane|ln\.?|drive|dr\.|boulevard|blvd|suite|floor|level|unit|flat|apt|po\s+box|p\.o\.|building|bldg|block|sector|house|plaza|way|court|ct\.?|circus|square|place|close|crescent|terrace|highway|landing|loop|cove|meadows?|mills?|straße|strasse|str\.|weg|platz|allee|gasse)\b|\b\d{4,6}\b|^\d+[\s,]/i;

// ---------------------------------------------------------------- totals block

export const TOTAL_STRONG =
  /\b(?:grand\s+total|total\s+(?:amount\s+)?(?:due|payable)|amount\s+(?:due|payable)|balance\s+(?:due|payable)|net\s+payable|total\s+incl(?:\.|uding|usive)?|invoice\s+total|total\s+invoice(?:\s+amount)?|amount\s+to\s+(?:be\s+)?pa(?:y|id)|total\s+to\s+pay|please\s+pay|total\s+bill|bill\s+amount|total\s+value\s+of\s+supply|gesamtbetrag|montant\s+total)\b/i;
export const TOTAL_WEAK = /^(?:total|totals|total\s+amount|amount|total\s*\([A-Z]{3}\)|total\s+[A-Z]{3})\s*:?$/i;
export const SUBTOTAL =
  /\b(?:sub\s*-?\s*total|net\s+(?:amount|total|value)|total\s+excl(?:\.|uding|usive)?|total\s+before\s+(?:tax|vat)|amount\s+before\s+(?:tax|vat)|taxable\s+(?:amount|value)|total\s+net|net\s+(?:goods|sales)|goods\s+total|nettobetrag|zwischensumme)\b/i;
export const TAX =
  /\b(?:vat|gst|hst|pst|qst|sales\s+tax|tax(?:\s+amount)?|total\s+tax|tax\s+total|total\s+vat|vat\s+total|cgst|sgst|igst|utgst|mwst|ust|tva|iva)\b/i;
export const NOT_TAX = /\b(?:excl(?:\.|uding)?|incl(?:\.|uding)?|before|reg(?:istration)?|id|no\.?|number|invoice|exempt\s+no)\b/i;
export const DISCOUNT = /\b(?:discount|rebate|reduction|less|rabatt|remise)\b/i;
export const SHIPPING = /\b(?:shipping|freight|delivery(?:\s+(?:charges?|fee))?|postage|handling|carriage|courier|transport(?:ation)?)\b/i;
export const NOT_TOTALS = /\b(?:cash|change|tendered|paid|payment|deposit|received|rounding|card|visa|mastercard|amex|balance\s+b\/f|previous\s+balance|credit\s+applied|qty|quantity|items?\s+count|no\.?\s+of\s+items|weight|kg)\b/i;
const TOTALS_KEYWORD =
  /^(?:sub\s*-?\s*total|total(?:s)?|grand\s+total|net\s+(?:total|amount|payable)|total\s+(?:due|payable|amount|excl\.?|incl\.?)(?:\s+(?:vat|gst|tax))?|amount\s+(?:due|payable)|balance\s+due|vat|gst|hst|tax|sales\s+tax|cgst|sgst|igst|discount|shipping|freight|delivery|handling)\b/i;

/** A bare totals label: the keyword plus at most a rate, a currency code or punctuation. */
export function isBareTotalsLabel(text: string): boolean {
  const t = text.trim();
  const m = TOTALS_KEYWORD.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length).replace(/\b[A-Z]{3}\b/g, '').replace(/\((?:incl|excl)\.?\s*(?:vat|gst|tax)\)/i, '');
  return !/[A-Za-z]/.test(rest);
}
export const TOTALS_ANY = new RegExp(
  [TOTAL_STRONG.source, SUBTOTAL.source, TAX.source, DISCOUNT.source, SHIPPING.source, '^\\s*total\\b'].join('|'),
  'i',
);

// ---------------------------------------------------------------- line-item table header

export const HEADER_ROLES: Array<{ role: 'description' | 'quantity' | 'unit_price' | 'amount' | 'position' | 'unit' | 'other'; re: RegExp }> = [
  { role: 'description', re: /^(?:description|item(?:s)?(?:\s+description)?|product(?:s)?|service(?:s)?|particulars|details|article|goods|description\s+of\s+(?:goods|services)|line\s+item|beschreibung|bezeichnung|designation)$/i },
  { role: 'quantity', re: /^(?:qty\.?|quantity|units?|hrs|hours|no\.?\s+of\s+\w+|pcs|nos|menge|qté|anzahl)$/i },
  { role: 'unit_price', re: /^(?:unit\s*price|price|rate|unit\s*cost|cost|each|u\.?\s*price|price\s+per\s+unit|rate\s*\(.*\)|unit\s+price\s*\(.*\)|price\s*\(.*\)|einzelpreis|prix\s+unitaire)$/i },
  { role: 'amount', re: /^(?:amount|total|line\s+total|net\s+amount|value|ext\.?\s*price|extended|sum|net|gross|amount\s*\(.*\)|total\s*\(.*\)|betrag|gesamt|montant)$/i },
  { role: 'position', re: /^(?:#|no\.?|sl\.?|s\.?\s*no\.?|sr\.?\s*no\.?|pos\.?|item\s+no\.?|line)$/i },
  { role: 'unit', re: /^(?:unit|uom|u\/m|einheit)$/i },
  { role: 'other', re: /^(?:hsn(?:\/sac)?|sac|tax|vat|gst|tax\s*%|vat\s*%|disc(?:ount)?\.?|code|sku|date|service\s+date)$/i },
];

export function headerRole(text: string): (typeof HEADER_ROLES)[number]['role'] | null {
  const t = text.trim().replace(/[:.]$/, '');
  for (const { role, re } of HEADER_ROLES) if (re.test(t)) return role;
  return null;
}

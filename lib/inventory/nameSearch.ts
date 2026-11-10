import brandPairs from '../brands/search.generated.json';

/** Only search keys are normalized; stored/displayed names and identifiers stay intact. */
export function normalizeNameSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja')
    .replace(/[\u3041-\u3096]/g, char => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (char: string | undefined) => Boolean(char && /[a-z0-9]/i.test(char));
const aliases = new Map<string, Set<string>>();
for (const pair of brandPairs) {
  const names = [...new Set(pair.map(normalizeNameSearch).map(name => name.trim()).filter(name => name.length >= 2))];
  for (const name of names) {
    const equivalents = aliases.get(name) ?? new Set<string>();
    for (const equivalent of names) equivalents.add(equivalent);
    aliases.set(name, equivalents);
  }
}
const byFirstChar = new Map<string, string[]>();
for (const alias of aliases.keys()) {
  const list = byFirstChar.get(alias[0]) ?? [];
  list.push(alias); byFirstChar.set(alias[0], list);
}
for (const list of byFirstChar.values()) list.sort((a, b) => b.length - a.length);

/** Expand registered brand names once per query, never once per inventory row.
 * Latin word boundaries keep Arper separate from Harper, and HAY from Hayward.
 * Remaining text is literal (including model numbers and regex punctuation).
 * Longest-match parsing avoids splitting a multi-word brand into other brands.
 */
export function createNameSearchMatcher(query: string): (normalizedName: string) => boolean {
  const key = normalizeNameSearch(query.trim());
  if (!key) return () => true;
  let pattern = '', literal = '', expanded = false;
  for (let i = 0; i < key.length;) {
    const alias = byFirstChar.get(key[i])?.find(name => key.startsWith(name, i)
      && !(word(name[0]) && word(key[i - 1]))
      && !(word(name[name.length - 1]) && word(key[i + name.length])));
    if (!alias) { literal += key[i++]; continue; }
    pattern += escape(literal); literal = ''; expanded = true;
    pattern += '(?:' + [...aliases.get(alias)!].map(name =>
      (word(name[0]) ? '(?<![a-z0-9])' : '') + escape(name)
      + (word(name[name.length - 1]) ? '(?![a-z0-9])' : '')).join('|') + ')';
    i += alias.length;
  }
  if (!expanded) return name => name.includes(key);
  const expression = new RegExp(pattern + escape(literal), 'u');
  return name => expression.test(name);
}

/** Quick search treats spaces as AND. Consume multi-word brand aliases before
 * splitting so Japanese/English equivalents still form one search term. */
export function createNameKeywordSearchMatcher(query: string): (normalizedName: string) => boolean {
  const key=normalizeNameSearch(query.trim()),terms:string[]=[];
  let literal='';
  const flush=()=>{terms.push(...literal.split(/\s+/u).filter(Boolean));literal='';};
  for(let i=0;i<key.length;){
    const alias=byFirstChar.get(key[i])?.find(name=>key.startsWith(name,i)
      && !(word(name[0])&&word(key[i-1]))
      && !(word(name[name.length-1])&&word(key[i+name.length])));
    if(alias){flush();terms.push(alias);i+=alias.length;}
    else literal+=key[i++];
  }
  flush();
  if(!/\s/u.test(key))return createNameSearchMatcher(query);
  const matchers=terms.map(createNameSearchMatcher);
  return name=>matchers.every(match=>match(name));
}

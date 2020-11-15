export const replacements = {
  filter: {
    '\0': '\\00',
    '(': '\\28',
    ')': '\\29',
    '*': '\\2a',
    '\\': '\\5c'
  },
  dnBegin: {
    ' ': '\\ '
  },
  dn: {
    '"': '\\"',
    '#': '\\#',
    '+': '\\+',
    ',': '\\,',
    ';': '\\;',
    '<': '\\<',
    '=': '\\=',
    '>': '\\>',
    '\\': '\\\\'
  },
  dnEnd: {
    ' ': '\\ '
  }
}
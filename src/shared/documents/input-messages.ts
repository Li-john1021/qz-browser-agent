import { defineMessages } from "../i18n/definition.js";
import { createTranslator } from "../i18n/index.js";

/** Authored document schemas and validation guidance; user document content is never translated. */
const messages = defineMessages("document-input", {
  "listItem": {
    "zh-CN": "列表项使用非空字符串，或 {text, children}；children 使用相同结构。",
    "en": "Use a nonempty string or {text, children} for each list item. Items in children use the same structure."
  },
  "tableRow": {
    "zh-CN": "每个数组元素表示一行：对象行写成 rows:[{\"列名\":\"值\"},{\"列名\":\"值\"}]，数组行写成 rows:[[\"值1\",\"值2\"],[\"值3\",\"值4\"]]；不要把多行再整体包进一个数组。同一张表不可混用两种行结构。",
    "en": "Each array element is one row: use rows:[{\"Column\":\"Value\"},{\"Column\":\"Value\"}] for object rows, or rows:[[\"Value1\",\"Value2\"],[\"Value3\",\"Value4\"]] for array rows. Do not wrap all rows in another array. Do not mix the two row formats in one table."
  },
  "blockType": {
    "zh-CN": "内容块类型；每个 block 都必须显式填写。",
    "en": "Block type. Specify this for every block."
  },
  "blockText": {
    "zh-CN": "paragraph、heading、code 的正文；link 的显示文本。",
    "en": "Body text for paragraph, heading, or code; display text for link."
  },
  "headingLevel": {
    "zh-CN": "heading 级别，默认 1。",
    "en": "Heading level. Defaults to 1."
  },
  "orderedList": {
    "zh-CN": "list 是否为有序列表，默认 false。",
    "en": "Whether the list is ordered. Defaults to false."
  },
  "listItems": {
    "zh-CN": "list 的非空列表项。",
    "en": "A nonempty array of list items."
  },
  "tableName": {
    "zh-CN": "table 名称；导出为工作簿时会作为 sheet 名称。不能包含 : \\ / ? * [ ]，也不能以单引号开头或结尾。",
    "en": "Table name, also used as the sheet name when exported to a workbook. Must not contain : \\ / ? * [ ] or start or end with a single quote."
  },
  "tableColumns": {
    "zh-CN": "table 的稳定非空列名。",
    "en": "Stable, nonempty column names for the table."
  },
  "header": {
    "zh-CN": "二维数组第一行是否为表头；默认 true。",
    "en": "Whether the first array row is a header. Defaults to true."
  },
  "url": {
    "zh-CN": "link 使用 http(s)、mailto、tel 或页内 #anchor；image 使用 http(s) 或 base64 编码的 PNG/JPEG/GIF/WebP。",
    "en": "For link: http(s), mailto, tel, or an in-page #anchor. For image: http(s) or a base64-encoded PNG/JPEG/GIF/WebP data URL."
  },
  "imageAlt": {
    "zh-CN": "image 的替代文本。",
    "en": "Alternative text for the image."
  },
  "imageCaption": {
    "zh-CN": "image 的说明文字。",
    "en": "Image caption."
  },
  "codeLanguage": {
    "zh-CN": "code 的语言标识。",
    "en": "Language identifier for the code block."
  },
  "codeStart": {
    "zh-CN": "code 的可选起始行号。",
    "en": "Optional starting line number for the code block."
  },
  "codeEnd": {
    "zh-CN": "code 的可选结束行号。",
    "en": "Optional ending line number for the code block."
  },
  "sheetName": {
    "zh-CN": "工作表名称；必须唯一，不能包含 : \\ / ? * [ ]，也不能以单引号开头或结尾。",
    "en": "Unique worksheet name. Must not contain : \\ / ? * [ ] or start or end with a single quote."
  },
  "columns": {
    "zh-CN": "稳定非空列名。",
    "en": "Stable, nonempty column names."
  },
  "bodyExample": {
    "zh-CN": "正文内容",
    "en": "Body text"
  },
  "headingExample": {
    "zh-CN": "执行摘要",
    "en": "Executive summary"
  },
  "itemOne": {
    "zh-CN": "事项一",
    "en": "First item"
  },
  "itemTwo": {
    "zh-CN": "事项二",
    "en": "Second item"
  },
  "people": {
    "zh-CN": "人员",
    "en": "People"
  },
  "personName": {
    "zh-CN": "姓名",
    "en": "Name"
  },
  "jobTitle": {
    "zh-CN": "职务",
    "en": "Role"
  },
  "person": {
    "zh-CN": "张三",
    "en": "Alex"
  },
  "director": {
    "zh-CN": "董事",
    "en": "Director"
  },
  "reference": {
    "zh-CN": "参考来源",
    "en": "Reference"
  },
  "illustration": {
    "zh-CN": "示意图",
    "en": "Illustration"
  },
  "blocksArray": {
    "zh-CN": "blocks 必须是数组。",
    "en": "blocks must be an array."
  },
  "sheetsArray": {
    "zh-CN": "sheets 必须是数组。",
    "en": "sheets must be an array."
  },
  "blockObject": {
    "zh-CN": "block 必须是对象。",
    "en": "block must be an object."
  },
  "blockTypeRequired": {
    "zh-CN": "每个 block 都必须显式提供 type。",
    "en": "Every block must explicitly specify type."
  },
  "headingRange": {
    "zh-CN": "heading.level 必须是 1 到 6 的整数。",
    "en": "heading.level must be an integer from 1 to 6."
  },
  "codeLineOrder": {
    "zh-CN": "code.endLine 不能小于 startLine。",
    "en": "code.endLine must not be less than startLine."
  },
  "orderedBoolean": {
    "zh-CN": "list.ordered 必须是 boolean。",
    "en": "list.ordered must be a boolean."
  },
  "itemsArray": {
    "zh-CN": "list.items 必须是非空数组。",
    "en": "list.items must be a nonempty array."
  },
  "itemEmpty": {
    "zh-CN": "列表项不能为空。",
    "en": "List items must not be empty."
  },
  "itemShape": {
    "zh-CN": "列表项必须是非空字符串或 {text, children} 对象。",
    "en": "A list item must be a nonempty string or an object with {text, children}."
  },
  "childrenArray": {
    "zh-CN": "列表项 children 必须是数组。",
    "en": "List item children must be an array."
  },
  "sheetObject": {
    "zh-CN": "sheet 必须是对象。",
    "en": "sheet must be an object."
  },
  "headerBoolean": {
    "zh-CN": "header 必须是 boolean。",
    "en": "header must be a boolean."
  },
  "columnsArray": {
    "zh-CN": "columns 必须是字符串数组。",
    "en": "columns must be an array of strings."
  },
  "columnNonempty": {
    "zh-CN": "列名必须是非空字符串。",
    "en": "Column names must be nonempty strings."
  },
  "rowsArray": {
    "zh-CN": "rows 必须是数组。",
    "en": "rows must be an array."
  },
  "tableContent": {
    "zh-CN": "table/sheet 至少需要 columns 或 rows。",
    "en": "A table/sheet must contain columns or rows."
  },
  "rowShape": {
    "zh-CN": "每一行必须是数组或对象。",
    "en": "Each row must be an array or object."
  },
  "mixedRows": {
    "zh-CN": "同一张表不能混用二维数组行和对象行。",
    "en": "Do not mix array rows and object rows in one table."
  },
  "emptyArrayRow": {
    "zh-CN": "二维数组行至少需要一个单元格。",
    "en": "Array rows must contain at least one cell."
  },
  "emptyObjectRow": {
    "zh-CN": "对象行至少需要一个字段。",
    "en": "Object rows must contain at least one field."
  },
  "cellType": {
    "zh-CN": "单元格只支持 string、number、boolean 或 null。",
    "en": "Cells only support string, number, boolean, or null values."
  },
  "sheetNameRequired": {
    "zh-CN": "工作表名称必须是非空字符串。",
    "en": "Worksheet names must be nonempty strings."
  },
  "sheetNameLength": {
    "zh-CN": "工作表名称最多 31 个字符。",
    "en": "Worksheet names must not exceed 31 characters."
  },
  "sheetNameCharacters": {
    "zh-CN": "工作表名称不能包含 : \\ / ? * [ ]，也不能以单引号开头或结尾。",
    "en": "Worksheet names must not contain : \\ / ? * [ ] or start or end with a single quote."
  },
  "textRequired": {
    "zh-CN": "必须提供非空字符串。",
    "en": "A nonempty string is required."
  },
  "urlRequired": {
    "zh-CN": "必须提供非空 URL。",
    "en": "A nonempty URL is required."
  },
  "imageUrl": {
    "zh-CN": "image.url 只支持 http(s) 或 base64 编码的 PNG/JPEG/GIF/WebP。",
    "en": "image.url only supports http(s) or a base64-encoded PNG/JPEG/GIF/WebP data URL."
  },
  "linkUrl": {
    "zh-CN": "link.url 只支持 http(s)、mailto、tel 或页内 #anchor。",
    "en": "link.url only supports http(s), mailto, tel, or an in-page #anchor."
  },
  "stringRequired": {
    "zh-CN": "必须是字符串。",
    "en": "Must be a string."
  },
  "positiveInteger": {
    "zh-CN": "必须是正整数。",
    "en": "Must be a positive integer."
  },
  "unsupportedBlock": {
    "zh-CN": "不支持的 block type：{type}。",
    "en": "Unsupported block type: {type}."
  },
  "unknownBlockFields": {
    "zh-CN": "{type} block 包含不支持的字段：{fields}。",
    "en": "Unsupported fields in {type} block: {fields}."
  },
  "listDepth": {
    "zh-CN": "嵌套列表最多支持 {depth} 层。",
    "en": "Lists can be nested up to {depth} levels deep."
  },
  "unknownItemFields": {
    "zh-CN": "列表项包含不支持的字段：{fields}。",
    "en": "Unsupported fields in list item: {fields}."
  },
  "unknownSheetFields": {
    "zh-CN": "sheet 包含不支持的字段：{fields}。",
    "en": "Unsupported fields in sheet: {fields}."
  },
  "duplicateColumn": {
    "zh-CN": "列名重复：{column}。",
    "en": "Duplicate column name: {column}."
  },
  "rowWidth": {
    "zh-CN": "表格行宽必须为 {width}。",
    "en": "Each table row must contain {width} cells."
  },
  "unknownRowFields": {
    "zh-CN": "对象行包含 columns 未声明的字段：{fields}。",
    "en": "Object row contains fields not declared in columns: {fields}."
  },
  "duplicateSheet": {
    "zh-CN": "工作表名称与 {path} 重复。",
    "en": "This worksheet name is already used at {path}."
  }
});

export const t = createTranslator(messages);

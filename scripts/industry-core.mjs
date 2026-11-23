// Deterministic product-level industry taxonomy. No Eagle calls and no LLM dependency.
// Industry identity belongs to a product, NEVER to the globally shared image itemId.
export const INDUSTRY_RULE_VERSION='industry-2026-11-v1';
export const INDUSTRIES=Object.freeze({
  adult:{label:'成人用品',subcategories:{female:'女用器具',male:'男用器具',accessory:'情趣道具',care:'润滑护理',other:'其它'}},
  electronics:{label:'3C数码',subcategories:{powerbank:'充电宝',charger:'充电器',cable:'数据线',accessory:'数码配件',other:'其它'}},
  apparel:{label:'服饰内衣',subcategories:{chestpad:'胸贴',leggings:'打底裤',underwear:'女士内衣',clothing:'服装',other:'其它'}},
  beauty:{label:'美妆护肤',subcategories:{other:'其它'}},
  home:{label:'家居日用',subcategories:{other:'其它'}},
  food:{label:'食品生鲜',subcategories:{other:'其它'}},
  pets:{label:'宠物用品',subcategories:{other:'其它'}},
  other:{label:'其它行业',subcategories:{other:'其它'}}
});
const EXACT=[
  ['adult','female',/(?:震动棒|振动棒|自慰器|跳蛋|吮吸玩具|吮吸|阴蒂|点潮笔|av棒|高潮神器|女性自慰|女用玩具|女用器具)/gi],
  ['adult','accessory',/(?:情趣道具|SM道具|情趣玩具|成人性用品|成人用品|情趣用品)/gi],
  ['electronics','powerbank',/(?:充电宝|移动电源)/gi],
  ['electronics','charger',/(?:充电器|充电头|氮化镓充电|快充插头|手机充电插头)/gi],
  ['electronics','cable',/(?:数据线|充电线|Type-C线|typec线)/gi],
  ['apparel','chestpad',/(?:胸贴|乳贴|防走光贴|隐形胸贴)/gi],
  ['apparel','leggings',/(?:打底裤|连裤袜|裤袜)/gi],
  ['apparel','underwear',/(?:文胸|内衣|胸罩)/gi]
];
const PRIORITY={female:3,accessory:1,powerbank:3,charger:2,cable:1,chestpad:3,leggings:3,underwear:2};
// Every matching token must be an actual product noun, not a loose AV/3C/mini token.
export function classifyProductTitle(title) {
  if(typeof title!=='string'||title.trim().length<2)
    return {industryCode:null,subcategoryCode:null,source:'rules',status:'needs_review',
      evidence:[],manualLocked:false,ruleVersion:INDUSTRY_RULE_VERSION,reason:'missing_title'};
  const normalized=title.normalize('NFKC').replace(/-tmall\.com天猫|-淘宝网$/ig,'').trim();
  const hits=EXACT.map(([industryCode,subcategoryCode,re])=>{
    re.lastIndex=0;const terms=[...new Set((normalized.match(re)||[]).map(x=>x.toLowerCase()))];
    return{industryCode,subcategoryCode,terms,score:terms.length*(PRIORITY[subcategoryCode]||1)};
  }).filter(x=>x.terms.length);
  const industries=[...new Set(hits.map(x=>x.industryCode))];
  if(industries.length!==1){
    return {industryCode:null,subcategoryCode:null,source:'rules',status:'needs_review',
      evidence:hits.flatMap(x=>x.terms).slice(0,8),manualLocked:false,
      ruleVersion:INDUSTRY_RULE_VERSION,reason:hits.length?'cross_industry_conflict':'no_specific_product_noun'};
  }
  const options=hits.sort((a,b)=>b.score-a.score||(PRIORITY[b.subcategoryCode]||0)-(PRIORITY[a.subcategoryCode]||0));
  const winner=options[0],industry=winner.industryCode;
  const conflict=options.some(x=>x.industryCode===industry&&x.subcategoryCode!==winner.subcategoryCode
    && x.score===winner.score && (PRIORITY[x.subcategoryCode]||0)===(PRIORITY[winner.subcategoryCode]||0));
  if(conflict)return {industryCode:null,subcategoryCode:null,source:'rules',status:'needs_review',
    evidence:hits.flatMap(x=>x.terms),manualLocked:false,ruleVersion:INDUSTRY_RULE_VERSION,reason:'ambiguous_product_nouns'};
  return{industryCode:industry,subcategoryCode:winner.subcategoryCode,source:'rules',
    status:'auto_confirmed',evidence:options.flatMap(x=>x.terms).slice(0,8),
    manualLocked:false,ruleVersion:INDUSTRY_RULE_VERSION};
}
export function classifyManual(industryCode,subcategoryCode){
  if(!Object.hasOwn(INDUSTRIES,industryCode)||!Object.hasOwn(INDUSTRIES[industryCode].subcategories,subcategoryCode))
    throw Error('Unknown industry/subcategory code');
  return{industryCode,subcategoryCode,source:'manual',status:'manual_confirmed',
    evidence:['manual_override'],manualLocked:true,ruleVersion:INDUSTRY_RULE_VERSION};
}
export function isConfidentClassification(value){
  return!!(value&&Object.hasOwn(INDUSTRIES,value.industryCode||'')&&
    Object.hasOwn(INDUSTRIES[value.industryCode].subcategories,value.subcategoryCode||'')&&
    ['auto_confirmed','manual_confirmed'].includes(value.status));
}
export const industryLabel=code=>INDUSTRIES[code]?.label||null;
export const subcategoryLabel=(industry,sub)=>INDUSTRIES[industry]?.subcategories[sub]||null;
export const industryTag=industry=>'采集行业｜'+industryLabel(industry);
export const subcategoryTag=(industry,sub)=>'采集子类｜'+industryLabel(industry)+'／'+subcategoryLabel(industry,sub);
export const isManagedTag=tag=>typeof tag==='string'&&
  (tag.startsWith('采集行业｜')||tag.startsWith('采集子类｜'));

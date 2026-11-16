// Pure, order-independent Eagle item mapping.
// A successful item_get response includes itemId, name, filePath and dimensions.
// Never trust item_add / item_get array positions or infer a missing item identity.
export function reconcileEagleItems(expected, added, readback) {
  if (!Array.isArray(expected) || !Array.isArray(added) || !Array.isArray(readback))
    throw Error('Eagle reconciliation expects three arrays');
  const issues=[];
  const names=new Set();
  for(const record of expected){
    if(typeof record.name!=='string'||!record.name.trim()||names.has(record.name))
      throw Error('Eagle input contains missing/duplicate names');
    names.add(record.name);
  }
  const idOf=item=>item?.itemId||item?.id||null;
  const submitted=new Map();
  for(const item of added){
    const id=idOf(item);
    if(!id){issues.push('item_add returned an entry without itemId');continue;}
    if(submitted.has(id)){issues.push('item_add returned duplicate itemId '+id);continue;}
    submitted.set(id,item);
  }
  const returned=new Map(),duplicateNames=new Set();
  for(const item of readback){
    const id=idOf(item),name=item?.name;
    if(!id||!submitted.has(id)){issues.push('item_get returned an unknown/invalid itemId');continue;}
    if(typeof name!=='string'||!name){issues.push('item_get item missing name: '+id);continue;}
    if(returned.has(name)){duplicateNames.add(name);issues.push('item_get returned duplicate name '+name);continue;}
    if(!names.has(name)){issues.push('item_get returned unexpected name '+name);continue;}
    const submittedName=submitted.get(id).name;
    if(submittedName && submittedName!==name){
      issues.push('Eagle item_add and item_get name disagree: '+id);continue;
    }
    returned.set(name,item);
  }
  const records=expected.map(record=>{
    const out={...record};
    const match=returned.get(record.name);
    if(!match||duplicateNames.has(record.name)){
      issues.push('No uniquely named verified item for '+record.name);
      return out;
    }
    const id=idOf(match);
    if(!(match.filePath&&match.width>0&&match.height>0)){
      issues.push('Eagle file/dimensions not verified for '+record.name);
      return out;
    }
    out.itemId=id;
    out.acknowledged=submitted.get(id).success===true;
    out.filePath=match.filePath;
    out.ext=match.ext||'jpg';
    out.savedWidth=match.width;
    out.savedHeight=match.height;
    out.verified=true;
    return out;
  });
  return {records,issues,returnedIds:[...submitted.keys()]};
}

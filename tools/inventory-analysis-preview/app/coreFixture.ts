import {createAnalysisAcquisitionReturnFixture,createAnalysisFixture} from '../../../lib/inventory/analysis/fixtures';
import {drilldownAnalysis,queryAnalysis} from '../../../lib/inventory/analysis/query';
import type {AnalysisPorts} from '../../../lib/inventory/analysisUi/model';

export function createCoreFixture(returned=false):{ports:AnalysisPorts} {
  const build = returned ? createAnalysisAcquisitionReturnFixture() : createAnalysisFixture();
  return {ports:{
    load:async request=>queryAnalysis(build,request),
    drill:async request=>drilldownAnalysis(build,request),
  }};
}

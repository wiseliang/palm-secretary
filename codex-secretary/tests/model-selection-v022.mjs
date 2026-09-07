import assert from 'node:assert/strict';
import { compatibleReasoningEffort, resolveModelSelection } from '../dist-server/model-selection.js';

const model = (name, efforts, defaultEffort, isDefault = false) => ({
  id: name,
  model: name,
  displayName: name,
  description: '',
  isDefault,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
  defaultReasoningEffort: defaultEffort,
});

const astra = model('gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low', true);
const sol = model('gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low');

assert.equal(compatibleReasoningEffort(astra, 'high'), 'high', '受支持的强度必须原样保留');
assert.equal(compatibleReasoningEffort(astra, 'none'), 'low', '旧 none 必须迁移到 low');
assert.equal(compatibleReasoningEffort(astra, 'minimal'), 'low', '旧 minimal 必须迁移到 low');
assert.equal(compatibleReasoningEffort(astra, 'ultra'), 'ultra', '账户模型列表声明支持的强度必须原样保留');
assert.equal(resolveModelSelection([astra, sol], 'gpt-5.6-sol', 'ultra').model?.model, 'gpt-5.6-sol', '仍可用的旧模型不能被强制替换');

const stale = resolveModelSelection([astra, sol], 'gpt-5.4-retired', 'minimal');
assert.equal(stale.model?.model, 'gpt-6-astra', '已下线模型应迁移到账户默认模型');
assert.equal(stale.reasoningEffort, 'low');
assert.equal(stale.migrated, true);

const implicit = resolveModelSelection([astra, sol], undefined, undefined);
assert.equal(implicit.model?.model, 'gpt-6-astra', '未显式配置时应使用账户模型列表中的默认模型');
assert.equal(implicit.reasoningEffort, 'low');
assert.equal(implicit.migrated, false, '隐式默认选择不应改写项目偏好');

const unavailable = resolveModelSelection([], 'gpt-5.6-sol', 'high');
assert.equal(unavailable.model, undefined, '模型列表不可用时必须允许上层沿用原配置');
assert.equal(unavailable.reasoningEffort, 'high');

console.log('model selection v022 tests passed');

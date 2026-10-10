export type ErrorCode =
  | 'RATE_LIMITED'
  | 'BAD_URL'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'SOGOU_BLOCKED'
  | 'WX_VERIFY_REQUIRED'
  | 'ARTICLE_DELETED'
  | 'ARTICLE_BLOCKED'
  | 'PARSE_FAILED'
  | 'NOT_CONFIGURED'
  | 'NOT_FOUND';

const HINTS: Partial<Record<ErrorCode, string>> = {
  RATE_LIMITED: '已暂停请求。请等待冷却结束，不要通过更换账号或代理重试。',
  SOGOU_BLOCKED: '搜狗要求验证，已暂停该站点请求。请稍后由用户在浏览器处理。',
  WX_VERIFY_REQUIRED: '微信要求验证，已暂停该站点请求。请由用户在正常浏览器或微信中处理。',
  ARTICLE_DELETED: '文章已被发布者删除，无法获取。',
  ARTICLE_BLOCKED: '文章因违规或其他原因无法查看。',
  NOT_CONFIGURED: '该能力需要额外凭据，请先完成配置后再调用。',
  NETWORK: '网络请求失败，检查网络连通性或代理配置（WECHAT_MP_PROXY）。',
  TIMEOUT: '请求超时，可调大 timeoutMs 或检查代理。',
};

export class WechatError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly detail?: unknown;

  constructor(code: ErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'WechatError';
    this.code = code;
    this.hint = HINTS[code];
    this.detail = detail;
  }

  toJSON() {
    return { error: this.code, message: this.message, hint: this.hint, detail: this.detail };
  }
}

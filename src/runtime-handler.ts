import { AdapterError } from './adapters/contract.js';
import { MarketingOpsError } from './errors.js';
import type { PublishService } from './publish-service.js';
import { failClosedToolHandler, type MarketingToolHandler } from './server-factory.js';

type PublishRuntime = Pick<PublishService, 'publish'>;

export function createRuntimeToolHandler(publishRuntime: PublishRuntime): MarketingToolHandler {
  return async (name, input) => {
    if (name !== 'publish_campaign') return failClosedToolHandler(name, input);
    try {
      const result = await publishRuntime.publish(input);
      return {
        data: result,
        ...(result.receipts.length === 0 && result.failures.length > 0 ? { isError: true } : {}),
      };
    } catch (error) {
      if (error instanceof AdapterError || error instanceof MarketingOpsError) {
        return { data: error.toJSON(), isError: true };
      }
      return {
        data: {
          code: 'ADAPTER_UNAVAILABLE',
          message: 'Publication runtime failed closed',
        },
        isError: true,
      };
    }
  };
}

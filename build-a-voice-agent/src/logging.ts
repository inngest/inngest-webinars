export type CorrelationRecord = Record<string, unknown>;
export type CorrelationLogger = (record: CorrelationRecord) => void;

export const defaultCorrelationLogger: CorrelationLogger = (record) => {
  console.log(JSON.stringify(record));
};

export function logCorrelation(
  logger: CorrelationLogger,
  event: string,
  fields: CorrelationRecord = {},
) {
  logger({ timestamp: new Date().toISOString(), event, ...fields });
}

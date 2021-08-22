import {
  SNSHandler,
  SNSEvent,
  SESEvent,
  SESMessage,
  SESReceiptS3Action,
} from 'aws-lambda';
import LambdaForwarder from 'aws-lambda-ses-forwarder';

export interface DispatcherConfig {
  fromEmail?: string | null;
  forwardMapping: Record<string, string[]>;
}

function isSESMessage(message: any): message is SESMessage {
  return (
    typeof message.mail !== 'undefined' &&
    typeof message.receipt !== 'undefined'
  );
}

function isSESReceiptS3Action(
  action: SESMessage['receipt']['action'],
): action is SESReceiptS3Action {
  return (
    action.type === 'S3' &&
    typeof action.objectKey !== 'undefined' &&
    typeof action.bucketName !== 'undefined'
  );
}

function getSESMessage(event: SNSEvent): SESMessage {
  if (event.Records.length !== 1) {
    throw new Error(
      'Dispatcher can only handle 1 record at a time; Please verify if the setup is correct',
    );
  }

  const [record] = event.Records;

  if (record.EventSource !== 'aws:sns') {
    throw new Error(
      `Unexpected event source: ${record.EventSource}; Only SNS Event is accepted at the moment`,
    );
  }

  const message = JSON.parse(record.Sns.Message);

  if (!isSESMessage(message)) {
    throw new Error(
      `Unexpected message received: ${record.Sns.Message}; Only SES Message is accepted at the moment`,
    );
  }

  return message;
}

/**
 * This handler will send a message from the SNS topic and forward it to the downstream email address.
 */
export const handler: SNSHandler = (event, context, callback) => {
  let message: SESMessage;

  // Lets verify that the message is an SES message...
  try {
    message = getSESMessage(event);

    console.log(message);

    if (!isSESReceiptS3Action(message.receipt.action)) {
      throw new Error(
        'The event is not triggered by S3 action; Please verify if the setup is correct',
      );
    }
  } catch (e) {
    console.log({
      level: 'error',
      message: e.message,
      event: JSON.stringify(event),
    });
    throw e;
  }

  // Now that we know its an SESMessage...
  //
  // not sure what this is

  console.log('message.receipt.action.objectKey');
  console.log(message.receipt.action.objectKey);

  const emailKeyPrefix = message.receipt.action.objectKey.replace(
    message.mail.messageId,
    '',
  );

  console.log('emailKeyPrefix');
  console.log(emailKeyPrefix);

  console.log('message.mail.messageId');
  console.log(message.mail.messageId);

  // This is the bucket that contains the email?
  const emailBucket = message.receipt.action.bucketName;

  const config = (process.env.CONFIG_PER_KEY_PREFIX ?? {}) as Record<
    string,
    DispatcherConfig
  >;

  const overrides = {
    config: {
      ...config[emailKeyPrefix],
      allowPlusSign: true,
      emailKeyPrefix,
      emailBucket,
    },
  };

  // Simulate SES Event so we can utilise aws-lambda-ses-forwarder for now
  // Based on documentation from
  // https://docs.aws.amazon.com/ses/latest/DeveloperGuide/receiving-email-notifications-contents.html#receiving-email-notifications-contents-top-level-json-object
  const sesEvent: SESEvent = {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: message,
      },
    ],
  };

  console.log('sesEvent');
  console.log(sesEvent);

  // SesEvent: Passes in Message
  // Message contains the SESEmail object
  // Context: passed into handle
  // ?
  // Callback: passed into handle
  // ?
  // Overrides: Contains a config, (allow plus sign, email prefix, bucket)
  LambdaForwarder.handler(sesEvent, context, callback, overrides);
};

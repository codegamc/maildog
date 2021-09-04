import {
  SNSHandler,
  SNSEvent,
  SESEvent,
  SESMessage,
  SESReceiptS3Action,
} from 'aws-lambda';
import LambdaForwarder from 'aws-lambda-ses-forwarder';

/**
 * The config for Dispatcher
 */
export interface DispatcherConfig {
  fromEmail?: string | null;
  forwardMapping: Record<string, string[]>;
}

/**
 * Checks if an object is an SESMessage. Specifically checks if Mail and Reciept are present.
 *  Does not check content or notificationType
 */
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

/**
 * Converts an SNS Event into an SES Message.
 * The description of an SES message is here:
 * https://docs.aws.amazon.com/ses/latest/DeveloperGuide/receiving-email-notifications-contents.html#receiving-email-notifications-contents-top-level-json-object
 */
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
 *
 *
 * Note to self: The SES rule set is not capable of handling reciept of an email that is sent to a subdomain.
 *
 */
export const handler: SNSHandler = (event, context, callback) => {
  let message: SESMessage;

  // Lets verify that the message is an SES message...
  try {
    message = getSESMessage(event);

    console.log('message');
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

  // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // //
  // Now that we know its an SESMessage, we can process it and establish the config required to return the message.       //
  // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // // //

  // IF the destination (message.receipt.recipients) contains "reply+AAABBCCC" then we need to treat this as a server-should-reply instead of incoming
  // reply: we respond to the original sender. Reply-all wil be an edge case to handle... (handle in encoding?) (multi-reply-encode?)

  // incoming: modify payload and forward it to the expected address.

  // This gets the domain that the email was sent to with a trailing slash
  // the object key is structured <domain>/<message id>
  // We can probably do message.receipt.action.objectKeyPrefix instead...
  const emailKeyPrefix = message.receipt.action.objectKey.replace(
    message.mail.messageId,
    '',
  );

  // This is the bucket that contains the email?
  const emailBucket = message.receipt.action.bucketName;

  // TODO: Add description here...
  const rawConfig = process.env.CONFIG_PER_KEY_PREFIX ?? {};

  const config = (process.env.CONFIG_PER_KEY_PREFIX ?? {}) as Record<
    string,
    DispatcherConfig
  >;

  // https://github.com/arithmetric/aws-lambda-ses-forwarder/blob/master/index.js
  const overridesOld = {
    // An object that defines the S3 storage location and mapping for email forwarding.
    config: {
      // Not sure what this does:
      // this notation is weird but i'm guessing this is actually getting the forwardMapping?

      // This returns the whole chunk of the JSON of the config. The "emailKeyPrefix" is the domain,
      // so returning the domain as a key
      ...config[emailKeyPrefix],

      // allowPlusSign: Enables support for plus sign suffixes on email addresses.
      //   If set to `true`, the username/mailbox part of an email address is parsed
      //   to remove anything after a plus sign. For example, an email sent to
      //   `example+test@example.com` would be treated as if it was sent to
      //   `example@example.com`.
      allowPlusSign: true,

      // The email key prefix is the domain of the original recipient.
      emailKeyPrefix,

      // The bucket that contains the email?
      emailBucket,

      // Supports:
      // fromEmail:"" // Forwarded emails will come from this verified address
      // subjectPrefix:"" // Forwarded emails subject will contain this prefix
      // emailBucket:""
      // emailKeyPrefix:""  // Include the trailing slash.
      // forwardMapping: {
      //     example@domain.com: [
      //      "newExamole@domain.com"
      //    ]
      //}
    },

    // Also available:

    // A function that accepts log messages for reporting. By default, this is set to console.log
    // log: () -> {},

    // An array of functions that should be executed to process and forward the email.
    // parse, transform, fetch, process, send...
    // we don't want to do anything here at the moment since that's a lot to unpack from the default.
    // steps:[],
  };

  console.log('overridesOld: ', overridesOld);

  const atDomain = '@' + emailKeyPrefix.slice(0, emailKeyPrefix.length - 1);
  const forwardDestination = config[emailKeyPrefix]['forwardMapping'][atDomain];
  const fromEmail = 'noreply' + atDomain;

  console.log('atDomain: ', atDomain);
  console.log('forwardDestination: ', forwardDestination);
  console.log('fromEmail: ', fromEmail);

  // const atDomainMapping = {
  //   atDomain: [forwardDestination as string],
  // } as Record<string, Array<string>>;

  const overrides = {
    config: {
      ...config[emailKeyPrefix],

      // This should become reply+BASE_64_ENCODED_DESTINATION
      // we need to adjust this (in the forwarding case)
      // fromEmail: fromEmail,

      // We don't want a subject prefix.
      subjectPrefix: '',

      // The bucket the original email is contained in
      emailBucket: emailBucket,

      // emailKeyPrefi
      emailKeyPrefix: emailKeyPrefix,

      // Do we really want or care about this? // TODO
      allowPlusSign: true,
      //
      forwardMapping: {
        //TODO: in future, any special overrides can end up here (if special domains are treated differently)
        // "example@domain.com":[
        //   "forward@address.com"
        // ],

        // All emails should get forwarded on...
        // this turns @domain.email as key, and forwardDestination (from config)
        // as the destination for that domain
        [atDomain as string]: [forwardDestination],
      },
    },
  };

  console.log('config post override');
  console.log(config);

  console.log('overrides');
  console.log(overrides);

  // Simulate SES Event so we can utilise aws-lambda-ses-forwarder for now
  // Based on documentation from
  // https://docs.aws.amazon.com/ses/latest/DeveloperGuide/receiving-email-notifications-contents.html#receiving-email-notifications-contents-top-level-json-object
  // SesEvent: Passes in Message
  // Message contains the SESEmail object
  const sesEvent: SESEvent = {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: message,
      },
    ],
  };

  LambdaForwarder.handler(sesEvent, context, callback, overrides);
};

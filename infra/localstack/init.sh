#!/bin/bash
# Provisionamento reprodutível das filas FIFO + DLQs + redrive (ADR-06).
set -euo pipefail

echo "==> criando DLQs FIFO"
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}'

awslocal sqs create-queue \
  --queue-name wager-events-dlq.fifo \
  --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}'

TX_DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --output text --query QueueUrl)" \
  --attribute-names QueueArn --output text --query 'Attributes.QueueArn')

EVENTS_DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-events-dlq.fifo --output text --query QueueUrl)" \
  --attribute-names QueueArn --output text --query 'Attributes.QueueArn')

echo "==> criando wager-transactions.fifo (redrive maxReceiveCount=5)"
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"45\",\"ReceiveMessageWaitTimeSeconds\":\"20\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${TX_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

echo "==> criando wager-events.fifo (redrive maxReceiveCount=10)"
awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"MessageRetentionPeriod\":\"345600\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${EVENTS_DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"}"

echo "==> filas provisionadas"
awslocal sqs list-queues

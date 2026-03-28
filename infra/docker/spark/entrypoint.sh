#!/bin/bash
# =============================================================================
# Spark K8s entrypoint — routes driver/executor modes.
#
# Spark K8s sets executor pod args to ["executor"] and communicates all
# executor parameters via SPARK_* environment variables. This script reads
# those env vars and builds the full command-line invocation, matching the
# official Apache Spark Docker image convention.
# =============================================================================
set -e

case "$1" in
  driver)
    shift
    exec "${SPARK_HOME}/bin/spark-class" org.apache.spark.deploy.SparkSubmit "$@"
    ;;
  executor)
    CMD=(
      "${SPARK_HOME}/bin/spark-class"
      "org.apache.spark.executor.CoarseGrainedExecutorBackend"
      --driver-url "${SPARK_DRIVER_URL}"
      --executor-id "${SPARK_EXECUTOR_ID}"
      --cores "${SPARK_EXECUTOR_CORES}"
      --app-id "${SPARK_APPLICATION_ID}"
      --hostname "${SPARK_EXECUTOR_POD_IP}"
      --resourceProfileId "${SPARK_RESOURCE_PROFILE_ID}"
    )
    exec "${CMD[@]}"
    ;;
  *)
    exec "$@"
    ;;
esac

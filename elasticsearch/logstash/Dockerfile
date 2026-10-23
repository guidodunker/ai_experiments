ARG STACK_VERSION
FROM docker.elastic.co/logstash/logstash:${STACK_VERSION}

# The JDBC input ships with Logstash, the PostgreSQL driver does not.
# Checksum verified against the SHA-1 published on Maven Central.
ARG PGJDBC_VERSION=42.7.14
# Create the directory first: ADD --chmod would otherwise apply 644 to it as well, making it untraversable.
USER root
RUN mkdir -p /usr/share/logstash/drivers && chmod 755 /usr/share/logstash/drivers
ADD --chmod=644 \
    --checksum=sha256:73914527305a40cce504b0d3d90b23caf565136912d607ae8ae7c5895512332c \
    https://repo1.maven.org/maven2/org/postgresql/postgresql/${PGJDBC_VERSION}/postgresql-${PGJDBC_VERSION}.jar \
    /usr/share/logstash/drivers/postgresql.jar
USER logstash

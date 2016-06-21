# grpc distribution protobufs

This directory contains copies of the grpc distribution protobuf definitions.

These are used in all grpc-defined rpc clients and servers that are distributed with dorusu.

The contents are maintained using the sync-grpc-pbs command, i.e, whenever there is a pertinent change, just run.


```bash

npm run sync-grpc-pbs

```

to update the copies here, and submit a PR with the changes.

# Tasks

## 1. Interface

- [x] 1. When the runtime interface reports engine details and network existence, the fake and the contract suite cover it

## 2. Pure helpers

- [x] 2. When paas looks for an engine socket or reads a raw log stream, pure helpers resolve the socket and split the stream

## 3. Docker adapter

- [x] 3. When the Docker adapter is driven through a stubbed client, it maps every operation and engine error per the contract

## 4. CLI

- [x] 4. When the CLI needs a runtime, it uses the Docker adapter by default, and paas doctor reports the engine

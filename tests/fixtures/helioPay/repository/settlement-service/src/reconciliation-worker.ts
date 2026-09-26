export class Worker { queue=new MemoryQueue(); async onTimeout(b){this.queue.push({batch:b,attempt:b.attempt+1});} }

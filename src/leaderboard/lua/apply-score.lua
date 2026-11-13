local currentVersion = redis.call('HGET', KEYS[3], ARGV[1])
if currentVersion and tonumber(currentVersion) >= tonumber(ARGV[4]) then
  return 0
end
local oldMember = redis.call('HGET', KEYS[2], ARGV[1])
if oldMember then
  redis.call('ZREM', KEYS[1], oldMember)
end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
return 1

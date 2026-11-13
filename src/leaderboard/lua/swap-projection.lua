if redis.call('GET', KEYS[8]) ~= ARGV[2] then
  return 0
end
if redis.call('EXISTS', KEYS[9]) == 0 then
  return -1
end
for index = 1, 3 do
  redis.call('DEL', KEYS[index])
  if redis.call('EXISTS', KEYS[index + 3]) == 1 then
    redis.call('RENAME', KEYS[index + 3], KEYS[index])
  end
end
redis.call('DEL', KEYS[9])
redis.call('SET', KEYS[7], ARGV[1])
redis.call('SET', KEYS[10], '1')
return 1

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/action-button";
export function SchedulingConnection() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [calendarName, setCalendarName] = useState("personal");
  const [writeEnabled, setWriteEnabled] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const utils = trpc.useUtils();
  const info = trpc.scheduling.connection.useQuery();
  const connect = trpc.scheduling.connect.useMutation({
    onSuccess: async () => {
      setPassword("");
      await utils.scheduling.invalidate();
    },
  });
  const disconnect = trpc.scheduling.disconnect.useMutation({
    onSuccess: async () => {
      setConfirmDisconnect(false);
      await utils.scheduling.invalidate();
    },
  });
  return (
    <section className="space-y-3 rounded-xl border p-6">
      <h2 className="text-xl font-semibold">我的日历连接</h2>
      {info.data?.enabled ? (
        <>
          <p>
            已连接：{info.data.username} / {info.data.calendarName}
          </p>
          <p className="text-sm">
            读取已授权；
            {info.data.writeEnabled ? "写入需本人确认" : "未授权写入"}
            。更换应用密码或权限可重新连接。
          </p>
          {confirmDisconnect ? (
            <div className="space-y-2">
              <p>
                解除连接将删除平台保存的访问凭据、停用忙闲委托，并使旧写入草稿失效；日历系统中的数据会保留。
              </p>
              <Button
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
              >
                确认解除连接
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmDisconnect(false)}
              >
                保留连接
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              onClick={() => setConfirmDisconnect(true)}
            >
              解除我的连接
            </Button>
          )}
        </>
      ) : (
        <p>
          使用日历系统中你自己的账号和应用密码授权平台访问，不需要管理员替你输入密码。
        </p>
      )}
      <details>
        <summary className="cursor-pointer">
          {info.data?.enabled ? "更新或更换本人连接" : "连接本人日历"}
        </summary>
        <form
          className="mt-3 space-y-3"
          onSubmit={e => {
            e.preventDefault();
            connect.mutate({
              username,
              appPassword: password,
              calendarName,
              writeEnabled,
              });
          }}
        >
          <label className="block">
            本人日历账号
            <input
              required
              maxLength={128}
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="ml-2 rounded border p-2"
            />
          </label>
          <label className="block">
            应用密码
            <input
              required
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="ml-2 rounded border p-2"
            />
          </label>
          <label className="block">
            日历名称
            <input
              required
              maxLength={128}
              value={calendarName}
              onChange={e => setCalendarName(e.target.value)}
              className="ml-2 rounded border p-2"
            />
          </label>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={writeEnabled}
              onChange={e => setWriteEnabled(e.target.checked)}
            />
            授权本人确认后写入日历
          </label>

          <p className="text-sm text-muted-foreground">
            连接会验证账号归属和日历可访问性。自动忙闲回复仍默认关闭，需要你单独开启。
          </p>
          <Button
            type="submit"
            disabled={connect.isPending || disconnect.isPending}
          >
            {connect.isPending ? "正在验证本人连接…" : "验证并授权连接"}
          </Button>
        </form>
      </details>
      {[info.error, connect.error, disconnect.error]
        .filter(Boolean)
        .map((error, index) => (
          <p role="alert" key={index}>
            {error!.message}
          </p>
        ))}
    </section>
  );
}

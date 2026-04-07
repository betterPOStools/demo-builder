"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface Props {
  onSaved: () => void;
  onCancel: () => void;
}

export function ConnectionForm({ onSaved, onCancel }: Props) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("192.168.40.141");
  const [port, setPort] = useState("3306");
  const [database, setDatabase] = useState("pecandemodb");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [uploadUrl, setUploadUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim() || !host.trim() || !database.trim() || !username.trim()) {
      toast.error("Fill in all required fields");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          host: host.trim(),
          port: parseInt(port) || 3306,
          database_name: database.trim(),
          username: username.trim(),
          password: password,
          upload_server_url: uploadUrl.trim() || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        throw new Error(err.error);
      }

      toast.success("Connection saved");
      onSaved();
    } catch (error: unknown) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 p-4">
      <div className="text-sm font-medium text-slate-300">New Connection</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="conn-name">Name *</Label>
          <Input
            id="conn-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Demo Tablet"
          />
        </div>
        <div>
          <Label htmlFor="conn-host">Host *</Label>
          <Input
            id="conn-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="conn-port">Port</Label>
          <Input
            id="conn-port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="conn-db">Database *</Label>
          <Input
            id="conn-db"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="conn-user">Username *</Label>
          <Input
            id="conn-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="conn-pass">Password</Label>
          <Input
            id="conn-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="conn-upload">Upload Server URL (optional)</Label>
          <Input
            id="conn-upload"
            value={uploadUrl}
            onChange={(e) => setUploadUrl(e.target.value)}
            placeholder="http://192.168.40.141:8081"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={saving} size="sm">
          {saving ? "Saving..." : "Save Connection"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

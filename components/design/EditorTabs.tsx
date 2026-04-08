"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MenuEditor } from "./MenuEditor";
import { ModifierDesigner } from "./ModifierDesigner";
import { LayoutEditor } from "./LayoutEditor";
import { BrandingEditor } from "./BrandingEditor";
import { POSPreview } from "./POSPreview";

export function EditorTabs() {
  return (
    <Tabs defaultValue="menu" className="w-full">
      <TabsList>
        <TabsTrigger value="menu">Menu</TabsTrigger>
        <TabsTrigger value="modifiers">Modifiers</TabsTrigger>
        <TabsTrigger value="layout">Layout</TabsTrigger>
        <TabsTrigger value="branding">Branding</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>

      <TabsContent value="menu">
        <MenuEditor />
      </TabsContent>

      <TabsContent value="modifiers">
        <ModifierDesigner />
      </TabsContent>

      <TabsContent value="layout">
        <LayoutEditor />
      </TabsContent>

      <TabsContent value="branding">
        <BrandingEditor />
      </TabsContent>

      <TabsContent value="preview">
        <POSPreview />
      </TabsContent>
    </Tabs>
  );
}

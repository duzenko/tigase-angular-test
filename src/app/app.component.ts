import { Inject } from '@angular/core';
import { Component } from '@angular/core';
import { ChatService, ChatServiceToken } from 'projects/ngx-chat/src/public-api';
import { TestLibService } from 'projects/test-lib/src/public-api';
import halcyon from 'halcyon-core-jsLegacy';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
	title = 'test-app';
	
	constructor( @Inject( ChatServiceToken ) chatService: ChatService ) {
		console.log( halcyon.tigase.halcyon.core.Halcyon())
		// const halcyon = Halcyon();
		// chatService.logIn( {
		// 	domain: '22.pss.com',
		// 	service: 'ws://localhost:5290',
		// 	password: '3fcb7c93-5794-4fe4-b7c2-e3d923e433da',
		// 	username: 'paul.garner_pavementsoft_com@22.pss.com',
		// } );
	}
}
